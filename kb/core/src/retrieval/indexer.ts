// The indexer: turn a knowledge base (topics/*.md + conversations/*.md) into
// LanceDB chunk rows. Reads each file, chunks it (chunker.ts), segments the chunk
// text for FTS (segmenter.ts), embeds the context-prefixed text (passage side),
// and tags kind (parent / sub / conversation). `reindex()` then hands the rows to
// the engine, which writes the table + manifest. This is `ka kb reindex`'s core.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../knowledge-store/markdown.js'
import { chunkTopic } from './chunker.js'
import { segment } from './segmenter.js'
import type { ChunkRow, LanceEngine } from './lance-engine.js'

export interface IndexerEmbedder {
  readonly model: string
  embedDocuments(texts: string[]): Promise<number[][]>
}

export interface BuiltIndex {
  rows: ChunkRow[]
  sourceMtimeMax: number
  docCount: number
}

interface FileEntry { path: string; abs: string; topic: string; kind: string; parent: string; mtime: number }

function listFiles(kbPath: string): FileEntry[] {
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
  const convDir = join(kbPath, 'conversations')
  if (existsSync(convDir)) {
    for (const f of readdirSync(convDir)) {
      if (!f.endsWith('.md')) continue
      const abs = join(convDir, f)
      out.push({ path: `conversations/${f}`, abs, topic: f.replace(/\.md$/, ''), kind: 'conversation', parent: `conversations/${f}`, mtime: statSync(abs).mtimeMs })
    }
  }
  return out
}

export async function buildChunkRows(kbPath: string, embedder: IndexerEmbedder): Promise<BuiltIndex> {
  const files = listFiles(kbPath)
  let sourceMtimeMax = 0

  // 1. chunk every file (cheap, sync) → flat list with the embed text.
  const pending: { row: Omit<ChunkRow, 'vector'>; embedText: string }[] = []
  for (const f of files) {
    sourceMtimeMax = Math.max(sourceMtimeMax, f.mtime)
    const raw = readFileSync(f.abs, 'utf-8')
    const { data } = parseFrontmatter(raw)
    const title = (data.title as string) ?? f.topic
    for (const c of chunkTopic(raw, { topic: f.topic })) {
      pending.push({
        embedText: c.embedText,
        row: {
          id: `${f.path}#${c.chunkIndex}`, path: f.path, topic: f.topic, kind: f.kind, parent: f.parent,
          title, heading: c.heading, chunk_index: c.chunkIndex, text: c.text, text_seg: segment(c.text),
          updated: (data.updated as string) ?? '',
        },
      })
    }
  }

  // 2. embed all chunks in one pass (passage side), assign vectors back.
  const vectors = await embedder.embedDocuments(pending.map((p) => p.embedText))
  const rows: ChunkRow[] = pending.map((p, i) => ({ ...p.row, vector: vectors[i] }))

  return { rows, sourceMtimeMax, docCount: files.length }
}

/** Build the index from a KB and (re)write the engine's table + manifest. */
export async function reindex(engine: LanceEngine, kbPath: string, embedder: IndexerEmbedder): Promise<BuiltIndex> {
  const built = await buildChunkRows(kbPath, embedder)
  await engine.rebuild(built.rows, {
    sourceMtimeMax: built.sourceMtimeMax,
    embedModel: embedder.model,
    docCount: built.docCount,
  })
  return built
}
