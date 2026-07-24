// Low-memory lexical retrieval backed by Node's built-in SQLite FTS5.
// Unlike the embedding backend this module loads neither fastembed/onnxruntime nor
// LanceDB. Text is pre-segmented with Intl.Segmenter so Chinese queries work with
// SQLite's portable unicode61 tokenizer.
import { mkdirSync } from 'node:fs'
import { createRequire as makeRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { MANIFEST_FILE, readManifest, writeManifest, type IndexManifest } from './manifest.js'
import { segment } from './segmenter.js'
import type { TextChunkRow } from './types.js'

export interface Fts5SearchHit {
  path: string
  topic: string
  title: string
  heading: string
  text: string
  kind: string
  score: number
}

export interface Fts5RebuildMeta {
  sourceMtimeMax?: number
  docCount?: number
  sourcePaths?: string[]
}

const KIND_WEIGHT: Record<string, number> = { parent: 1, sub: 1, conversation: 0.5 }
// Vite 5 (used by this repo's Vitest) predates node:sqlite and rewrites a static
// import to a nonexistent "sqlite" package. createRequire keeps the runtime-owned
// built-in opaque to Vite while preserving Node 22's zero-dependency implementation.
const { DatabaseSync } = makeRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

function matchExpression(query: string): string {
  const tokens = [...new Set(segment(query).split(/\s+/).map((s) => s.trim()).filter(Boolean))]
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

export class Fts5Engine {
  private db: DatabaseSyncType | null = null
  private readonly manifestPath: string

  constructor(private readonly dbPath: string) {
    this.manifestPath = join(dirname(dbPath), MANIFEST_FILE)
  }

  private conn(): DatabaseSyncType {
    if (this.db) return this.db
    mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        id UNINDEXED,
        path UNINDEXED,
        topic UNINDEXED,
        kind UNINDEXED,
        parent UNINDEXED,
        title UNINDEXED,
        heading UNINDEXED,
        chunk_index UNINDEXED,
        text UNINDEXED,
        searchable,
        updated UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );
    `)
    this.db = db
    return db
  }

  private insertRows(rows: TextChunkRow[]): void {
    const stmt = this.conn().prepare(`
      INSERT INTO chunks
        (id,path,topic,kind,parent,title,heading,chunk_index,text,searchable,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `)
    for (const r of rows) {
      stmt.run(
        r.id, r.path, r.topic, r.kind, r.parent, r.title, r.heading,
        r.chunk_index, r.text, segment(`${r.title} ${r.heading} ${r.text}`), r.updated,
      )
    }
  }

  rebuild(rows: TextChunkRow[], meta: Fts5RebuildMeta = {}): void {
    const prev = readManifest(this.manifestPath)?.version ?? 0
    const db = this.conn()
    try {
      db.exec('BEGIN IMMEDIATE; DELETE FROM chunks;')
      this.insertRows(rows)
      db.exec('COMMIT;')
      writeManifest(this.manifestPath, {
        engine: 'fts5',
        version: prev + 1,
        built_at: new Date().toISOString(),
        source_mtime_max: meta.sourceMtimeMax ?? 0,
        doc_count: meta.docCount ?? new Set(rows.map((r) => r.path)).size,
        chunk_count: rows.length,
        source_paths: meta.sourcePaths ?? [...new Set(rows.map((r) => r.path))],
        embed_model: '',
        status: 'ok',
        error: null,
      })
    } catch (error) {
      try { db.exec('ROLLBACK;') } catch { /* no active transaction */ }
      this.writeError(error, prev)
      throw error
    }
  }

  upsert(
    rows: TextChunkRow[],
    opts: { changedPaths?: string[]; removedPaths?: string[]; sourceMtimeMax?: number } = {},
  ): void {
    const cur = readManifest(this.manifestPath)
    const db = this.conn()
    try {
      db.exec('BEGIN IMMEDIATE;')
      const changed = [...new Set([...(opts.changedPaths ?? []), ...rows.map((r) => r.path)])]
      const removed = [...new Set(opts.removedPaths ?? [])]
      const del = db.prepare('DELETE FROM chunks WHERE path = ?')
      for (const path of [...new Set([...changed, ...removed])]) del.run(path)
      this.insertRows(rows)
      db.exec('COMMIT;')
      const counts = db.prepare(
        'SELECT count(*) AS chunks, count(DISTINCT path) AS docs FROM chunks',
      ).get() as { chunks: number; docs: number }
      const sourcePaths = [
        ...new Set([
          ...(cur?.source_paths ?? this.queryIndexedPaths())
            .filter((path) => !(opts.removedPaths ?? []).includes(path)),
          ...(opts.changedPaths ?? rows.map((r) => r.path)),
        ]),
      ]
      writeManifest(this.manifestPath, {
        engine: 'fts5',
        version: (cur?.version ?? 0) + 1,
        built_at: new Date().toISOString(),
        source_mtime_max: Math.max(cur?.source_mtime_max ?? 0, opts.sourceMtimeMax ?? 0),
        doc_count: sourcePaths.length || Number(counts.docs),
        chunk_count: Number(counts.chunks),
        source_paths: sourcePaths,
        embed_model: '',
        status: 'ok',
        error: null,
      })
    } catch (error) {
      try { db.exec('ROLLBACK;') } catch { /* no active transaction */ }
      this.writeError(error, cur?.version ?? 0)
      throw error
    }
  }

  private writeError(error: unknown, version: number): void {
    const cur = readManifest(this.manifestPath)
    writeManifest(this.manifestPath, {
      engine: 'fts5',
      version,
      built_at: cur?.built_at ?? new Date().toISOString(),
      source_mtime_max: cur?.source_mtime_max ?? 0,
      doc_count: cur?.doc_count ?? 0,
      chunk_count: cur?.chunk_count ?? 0,
      source_paths: cur?.source_paths,
      embed_model: '',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  status(): IndexManifest | null {
    return readManifest(this.manifestPath)
  }

  indexedPaths(): string[] {
    const manifest = this.status()
    if (!manifest) return []
    if (manifest.source_paths) return manifest.source_paths
    return this.queryIndexedPaths()
  }

  private queryIndexedPaths(): string[] {
    const rows = this.conn().prepare('SELECT DISTINCT path FROM chunks').all() as Array<{ path: string }>
    return rows.map((r) => r.path)
  }

  search(query: string, topK = 5, fetch = 50): Fts5SearchHit[] {
    const match = matchExpression(query)
    if (!match || !this.status()) return []
    const rows = this.conn().prepare(`
      SELECT path, topic, title, heading, text, kind, bm25(chunks) AS rank
      FROM chunks
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(match, fetch) as Array<{
      path: string; topic: string; title: string; heading: string
      text: string; kind: string; rank: number
    }>

    // FTS5's BM25 is negative and corpus-relative. Expose a stable rank score
    // after topic-level dedupe instead of pretending it is vector similarity.
    const byTopic = new Map<string, typeof rows[number]>()
    for (const row of rows) {
      const key = row.topic || row.path
      if (!byTopic.has(key)) byTopic.set(key, row)
    }
    return [...byTopic.values()].slice(0, topK).map((row, index) => ({
      path: row.path,
      topic: row.topic,
      title: row.title,
      heading: row.heading,
      text: row.text,
      kind: row.kind,
      score: (KIND_WEIGHT[row.kind] ?? 1) / (index + 1),
    }))
  }

  optimize(): void {
    const db = this.conn()
    db.exec("INSERT INTO chunks(chunks) VALUES('optimize');")
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
