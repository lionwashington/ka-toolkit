// The indexer: turn a knowledge base into LanceDB chunk rows. ONLY topics/*.md are
// indexed — they are the distilled, structured knowledge. Raw conversations/*.md are
// NOT indexed (industry practice: don't make raw dialogue logs a retrieval target —
// they're noisy, redundant, and balloon the index/reindex cost; they stay as trace
// material that distill mines into topics, and retrieval targets the topics). Reads
// each topic, chunks it (chunker.ts), segments for FTS (segmenter.ts), embeds the
// context-prefixed text (passage side), tags kind (parent / sub). `reindex()` hands
// the rows to the engine, which writes the table + manifest. Core of `ka kb reindex`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../knowledge-store/markdown.js'
import { chunkTopic } from './chunker.js'
import { segment } from './segmenter.js'
import type { ChunkRow, LanceEngine } from './lance-engine.js'
import type { TextChunkRow } from './types.js'

export interface IndexerEmbedder {
  readonly model: string
  embedDocuments(texts: string[]): Promise<number[][]>
}

export interface BuiltIndex {
  rows: ChunkRow[]
  sourceMtimeMax: number
  docCount: number
}

export interface FileEntry { path: string; abs: string; topic: string; kind: string; parent: string; mtime: number }

export function listTopicFiles(kbPath: string): FileEntry[] {
  const out: FileEntry[] = []
  const topicsDir = join(kbPath, 'topics')
  if (existsSync(topicsDir)) {
    for (const f of readdirSync(topicsDir)) {
      if (!f.endsWith('.md')) continue
      const abs = join(topicsDir, f)
      const stem = f.replace(/\.md$/, '')
      const { data } = parseFrontmatter(readFileSync(abs, 'utf-8'))
      const parentField = typeof data.parent === 'string' ? data.parent.replace(/\.md$/, '') : ''
      out.push({
        path: `topics/${f}`, abs, topic: stem,
        kind: parentField ? 'sub' : 'parent',
        parent: parentField ? `topics/${parentField}.md` : `topics/${f}`,
        mtime: statSync(abs).mtimeMs,
      })
    }
  }
  // conversations/ is intentionally NOT indexed — distill mines it into topics;
  // retrieval targets the distilled topics only (see file header).
  return out
}

/** Chunk + embed a given set of files → ChunkRow[] (shared by full + incremental). */
export function buildTextRowsForFiles(files: FileEntry[]): Array<TextChunkRow & { embedText: string }> {
  const pending: Array<TextChunkRow & { embedText: string }> = []
  for (const f of files) {
    const raw = readFileSync(f.abs, 'utf-8')
    const { data } = parseFrontmatter(raw)
    const title = (data.title as string) ?? f.topic
    for (const c of chunkTopic(raw, { topic: f.topic })) {
      pending.push({
        embedText: c.embedText,
        ...{
          id: `${f.path}#${c.chunkIndex}`, path: f.path, topic: f.topic, kind: f.kind, parent: f.parent,
          title, heading: c.heading, chunk_index: c.chunkIndex, text: c.text, text_seg: segment(c.text),
          updated: (data.updated as string) ?? '',
        },
      })
    }
  }
  return pending
}

async function buildRowsForFiles(files: FileEntry[], embedder: IndexerEmbedder): Promise<ChunkRow[]> {
  const pending = buildTextRowsForFiles(files)
  if (pending.length === 0) return []
  const vectors = await embedder.embedDocuments(pending.map((p) => p.embedText))
  return pending.map(({ embedText: _embedText, ...row }, i) => ({ ...row, vector: vectors[i] }))
}

export async function buildChunkRows(kbPath: string, embedder: IndexerEmbedder): Promise<BuiltIndex> {
  const files = listTopicFiles(kbPath)
  const sourceMtimeMax = files.reduce((m, f) => Math.max(m, f.mtime), 0)
  const rows = await buildRowsForFiles(files, embedder)
  return { rows, sourceMtimeMax, docCount: files.length }
}

/** Build the index from a KB and (re)write the engine's table + manifest (full rebuild). */
export async function reindex(engine: LanceEngine, kbPath: string, embedder: IndexerEmbedder): Promise<BuiltIndex> {
  const built = await buildChunkRows(kbPath, embedder)
  await engine.rebuild(built.rows, {
    sourceMtimeMax: built.sourceMtimeMax,
    embedModel: embedder.model,
    docCount: built.docCount,
    sourcePaths: listTopicFiles(kbPath).map((file) => file.path),
  })
  return built
}

export interface IncrementalResult {
  changedPaths: string[]
  removedPaths: string[]
  rowCount: number
  sourceMtimeMax: number
}

/**
 * Incremental reindex: re-embed only the files changed since the index's
 * source_mtime_max (from the manifest) and upsert them; also drop rows for files
 * that vanished from disk. Returns what changed. No-op (no upsert) when nothing
 * changed. This is what distill calls after writing topics — seconds, not a full
 * rebuild. `since` overrides the manifest mtime (mainly for tests).
 */
export async function incrementalReindex(
  engine: LanceEngine,
  kbPath: string,
  embedder: IndexerEmbedder,
  since?: number,
): Promise<IncrementalResult> {
  const sinceMtime = since ?? engine.status()?.source_mtime_max ?? 0
  const files = listTopicFiles(kbPath)
  const onDisk = new Set(files.map((f) => f.path))
  const indexedPaths = await engine.indexedPaths()
  const indexed = new Set(indexedPaths)
  // A migrated/copied file may retain an mtime older than the global watermark.
  // It is still new if its path has never been indexed.
  const changed = files.filter((f) => f.mtime > sinceMtime || !indexed.has(f.path))
  // Removed = paths the index knew about but that no longer exist on disk.
  const removedPaths = indexedPaths.filter((p) => !onDisk.has(p))
  if (changed.length === 0 && removedPaths.length === 0) {
    return { changedPaths: [], removedPaths: [], rowCount: 0, sourceMtimeMax: sinceMtime }
  }
  const rows = await buildRowsForFiles(changed, embedder)
  const sourceMtimeMax = files.reduce((m, f) => Math.max(m, f.mtime), sinceMtime)
  await engine.upsert(rows, {
    changedPaths: changed.map((file) => file.path),
    removedPaths,
    sourceMtimeMax,
    embedModel: embedder.model,
  })
  return { changedPaths: changed.map((f) => f.path), removedPaths, rowCount: rows.length, sourceMtimeMax }
}
