import type { Fts5Engine } from './fts5-engine.js'
import { buildTextRowsForFiles, listTopicFiles } from './indexer.js'

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
  const changed = files.filter((file) => file.mtime > sinceMtime || !indexed.has(file.path))
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
  })
  return {
    changedPaths: changed.map((file) => file.path),
    removedPaths,
    rowCount: rows.length,
    sourceMtimeMax,
  }
}
