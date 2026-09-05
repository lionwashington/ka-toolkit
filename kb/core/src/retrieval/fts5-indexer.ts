import type { Fts5Engine } from './fts5-engine.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { buildTextRowsForFiles, listTopicFiles } from './indexer.js'

function fingerprint(file: ReturnType<typeof listTopicFiles>[number]): string {
  // Version the transformation; upgrading it deliberately invalidates old rows.
  return 'fts5-v1:' + createHash('sha256').update(file.raw ?? readFileSync(file.abs, 'utf8')).digest('hex')
}

export interface Fts5IndexResult {
  changedPaths: string[]
  removedPaths: string[]
  rowCount: number
  docCount?: number
  sourceMtimeMax: number
}

export function reindexFts5(engine: Fts5Engine, kbPath: string): Fts5IndexResult {
  const files = listTopicFiles(kbPath)
  const rows = buildTextRowsForFiles(files).map(({ embedText: _embedText, ...row }) => row)
  const sourceMtimeMax = files.reduce((max, file) => Math.max(max, file.mtime), 0)
  engine.rebuild(rows, {
    sourceMtimeMax,
    docCount: files.length,
    sourcePaths: files.map((file) => file.path),
    fingerprints: Object.fromEntries(files.map(file => [file.path, fingerprint(file)])),
  })
  return {
    changedPaths: files.map((file) => file.path),
    removedPaths: [],
    rowCount: rows.length,
    docCount: files.length,
    sourceMtimeMax,
  }
}

export function incrementalReindexFts5(
  engine: Fts5Engine,
  kbPath: string,
  since?: number,
): Fts5IndexResult {
  const sinceMtime = since ?? engine.status()?.source_mtime_max ?? 0
  const files = listTopicFiles(kbPath)
  const onDisk = new Set(files.map((file) => file.path))
  const indexedPaths = engine.indexedPaths()
  const indexed = new Set(indexedPaths)
  const previous = engine.fingerprints()
  const hashes = Object.fromEntries(files.map(file => [file.path, fingerprint(file)]))
  const changed = files.filter(file => hashes[file.path] !== previous[file.path] || !indexed.has(file.path) || (since !== undefined && file.mtime > since))
  const removedPaths = indexedPaths.filter((path) => !onDisk.has(path))
  if (changed.length === 0 && removedPaths.length === 0) {
    return {
      changedPaths: [],
      removedPaths: [],
      rowCount: 0,
      sourceMtimeMax: sinceMtime,
    }
  }
  const rows = buildTextRowsForFiles(changed).map(({ embedText: _embedText, ...row }) => row)
  const sourceMtimeMax = files.reduce((max, file) => Math.max(max, file.mtime), sinceMtime)
  engine.upsert(rows, {
    changedPaths: changed.map((file) => file.path),
    removedPaths,
    sourceMtimeMax,
    fingerprints: Object.fromEntries(changed.map(file => [file.path, hashes[file.path]])),
  })
  return {
    changedPaths: changed.map((file) => file.path),
    removedPaths,
    rowCount: rows.length,
    sourceMtimeMax,
  }
}
