// The LanceDB hybrid retrieval engine: vector ANN + Intl-segmented FTS, fused by
// RRF (rank-based, so no score normalization needed — which lets us drop the old
// un-normalized min_score cutoff). Results are de-duped to topic level (best chunk
// per topic) and conversations are down-weighted (they polluted the old ranking).
// MCP tool signatures are unchanged; this lives behind the KnowledgeRetrieval layer.
import { join } from 'node:path'
import * as lancedb from '@lancedb/lancedb'
import { segment } from './segmenter.js'
import {
  MANIFEST_FILE,
  readManifest,
  writeManifest,
  type IndexManifest,
} from './manifest.js'

export interface ChunkRow {
  id: string
  path: string
  topic: string
  kind: string // 'parent' | 'sub' | 'conversation'
  parent: string
  title: string
  heading: string
  chunk_index: number
  /** Raw chunk text — returned as the excerpt. */
  text: string
  /** Intl-segmented text — the FTS column. */
  text_seg: string
  vector: number[]
  updated: string
}

export interface SearchHit {
  path: string
  topic: string
  title: string
  heading: string
  text: string
  kind: string
  score: number
}

export interface EngineEmbedder {
  embedQuery(text: string): Promise<number[]>
}

/** Build-time metadata recorded in the index manifest. */
export interface RebuildMeta {
  sourceMtimeMax?: number
  embedModel?: string
  docCount?: number
}

/** Per-kind weight in the fusion — conversations rank below topic files. */
const KIND_WEIGHT: Record<string, number> = { parent: 1, sub: 1, conversation: 0.5 }
const RRF_K = 60

export class LanceEngine {
  private db: lancedb.Connection | null = null
  private tbl: lancedb.Table | null = null
  private readonly manifestPath: string
  /** Manifest version the currently-open table reflects (-1 = none loaded). */
  private loadedVersion = -1

  constructor(
    private readonly dbPath: string,
    private readonly embedder: EngineEmbedder,
    private readonly tableName = 'kb',
  ) {
    this.manifestPath = join(dbPath, MANIFEST_FILE)
  }

  private async conn() {
    if (!this.db) this.db = await lancedb.connect(this.dbPath)
    return this.db
  }

  /**
   * Full rebuild: drop + recreate the table from chunk rows, build the FTS index,
   * then write the manifest (version bump). On failure the manifest records
   * status:'error' and the error is RE-THROWN — never silently swallowed.
   */
  async rebuild(rows: ChunkRow[], meta: RebuildMeta = {}): Promise<void> {
    const prev = readManifest(this.manifestPath)?.version ?? 0
    try {
      const db = await this.conn()
      try { await db.dropTable(this.tableName) } catch { /* table may not exist */ }
      if (rows.length === 0) {
        this.tbl = null
      } else {
        // ChunkRow is a typed interface; LanceDB's createTable wants Record<string,unknown>[].
        this.tbl = await db.createTable(this.tableName, rows as unknown as Record<string, unknown>[])
        await this.tbl.createIndex('text_seg', { config: lancedb.Index.fts(), replace: true })
      }
      const m: IndexManifest = {
        engine: 'lancedb',
        version: prev + 1,
        built_at: new Date().toISOString(),
        source_mtime_max: meta.sourceMtimeMax ?? 0,
        doc_count: meta.docCount ?? new Set(rows.map((r) => r.path)).size,
        chunk_count: rows.length,
        embed_model: meta.embedModel ?? '',
        status: 'ok',
        error: null,
      }
      writeManifest(this.manifestPath, m)
      this.loadedVersion = m.version
    } catch (e) {
      // Fail loud: record the failure in the manifest (old table left in place), re-throw.
      const cur = readManifest(this.manifestPath)
      writeManifest(this.manifestPath, {
        engine: 'lancedb',
        version: cur?.version ?? prev,
        built_at: cur?.built_at ?? new Date().toISOString(),
        source_mtime_max: cur?.source_mtime_max ?? 0,
        doc_count: cur?.doc_count ?? 0,
        chunk_count: cur?.chunk_count ?? 0,
        embed_model: cur?.embed_model ?? '',
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }

  /**
   * Incremental update: replace the rows for the changed files (delete their old
   * rows, add the new ones) + drop rows for removed files, refresh the FTS index,
   * and bump the manifest (version + source_mtime_max). Far cheaper than rebuild()
   * — the caller only re-embeds the touched files. If the table doesn't exist yet
   * this behaves like a first build. Fail-loud: on error the manifest records
   * status:'error' and the error is re-thrown.
   */
  async upsert(
    rows: ChunkRow[],
    opts: { removedPaths?: string[]; sourceMtimeMax?: number; embedModel?: string } = {},
  ): Promise<void> {
    const cur = readManifest(this.manifestPath)
    const prev = cur?.version ?? 0
    try {
      const db = await this.conn()
      const exists = (await db.tableNames()).includes(this.tableName)
      if (!exists) {
        this.tbl = rows.length
          ? await db.createTable(this.tableName, rows as unknown as Record<string, unknown>[])
          : null
        if (this.tbl) await this.tbl.createIndex('text_seg', { config: lancedb.Index.fts(), replace: true })
      } else {
        const tbl = await db.openTable(this.tableName)
        const changed = [...new Set(rows.map((r) => r.path))]
        const deletePaths = [...new Set([...changed, ...(opts.removedPaths ?? [])])]
        if (deletePaths.length) {
          const inList = deletePaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')
          await tbl.delete(`path IN (${inList})`)
        }
        if (rows.length) await tbl.add(rows as unknown as Record<string, unknown>[])
        // The FTS (tantivy) index must be refreshed to cover the newly added rows.
        await tbl.createIndex('text_seg', { config: lancedb.Index.fts(), replace: true })
        this.tbl = tbl
      }
      let docCount = 0
      let chunkCount = 0
      if (this.tbl) {
        chunkCount = await this.tbl.countRows()
        const paths = await this.tbl.query().select(['path']).toArray()
        docCount = new Set(paths.map((r: any) => r.path)).size
      }
      const m: IndexManifest = {
        engine: 'lancedb',
        version: prev + 1,
        built_at: new Date().toISOString(),
        source_mtime_max: Math.max(cur?.source_mtime_max ?? 0, opts.sourceMtimeMax ?? 0),
        doc_count: docCount,
        chunk_count: chunkCount,
        embed_model: opts.embedModel ?? cur?.embed_model ?? '',
        status: 'ok',
        error: null,
      }
      writeManifest(this.manifestPath, m)
      this.loadedVersion = m.version
    } catch (e) {
      writeManifest(this.manifestPath, {
        engine: 'lancedb',
        version: cur?.version ?? prev,
        built_at: cur?.built_at ?? new Date().toISOString(),
        source_mtime_max: cur?.source_mtime_max ?? 0,
        doc_count: cur?.doc_count ?? 0,
        chunk_count: cur?.chunk_count ?? 0,
        embed_model: cur?.embed_model ?? '',
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }

  /** The current manifest (null if the index was never built). */
  status(): IndexManifest | null {
    return readManifest(this.manifestPath)
  }

  /** Distinct source paths currently in the index ([] if no table) — for deletion detection. */
  async indexedPaths(): Promise<string[]> {
    if (!readManifest(this.manifestPath)) return []
    try {
      const tbl = await this.table()
      const rows = await tbl.query().select(['path']).toArray()
      return [...new Set(rows.map((r: any) => r.path))]
    } catch {
      return []
    }
  }

  private async table() {
    // Reload-on-version: if a writer bumped the manifest since we opened the table,
    // re-open so this long-lived reader serves the latest committed build.
    const m = readManifest(this.manifestPath)
    if (m && m.version !== this.loadedVersion) {
      this.tbl = null
      this.loadedVersion = m.version
    }
    if (!this.tbl) {
      const db = await this.conn()
      this.tbl = await db.openTable(this.tableName)
    }
    return this.tbl
  }

  /** Hybrid search: vector top-N + FTS top-N → RRF fuse → dedupe to topic → top-k. */
  async search(query: string, topK = 5, fetch = 30): Promise<SearchHit[]> {
    const tbl = await this.table()
    const qv = await this.embedder.embedQuery(query)
    const qseg = segment(query)
    const [vec, fts] = await Promise.all([
      tbl.search(qv).limit(fetch).toArray().catch(() => [] as any[]),
      qseg ? tbl.query().fullTextSearch(qseg).limit(fetch).toArray().catch(() => [] as any[]) : Promise.resolve([] as any[]),
    ])

    // Reciprocal-rank fusion, weighted by kind.
    const fused = new Map<string, { row: any; score: number }>()
    const addList = (list: any[]) => {
      list.forEach((row, i) => {
        const w = KIND_WEIGHT[row.kind] ?? 1
        const inc = w / (RRF_K + i + 1)
        const cur = fused.get(row.id)
        if (cur) cur.score += inc
        else fused.set(row.id, { row, score: inc })
      })
    }
    addList(vec)
    addList(fts)

    // Dedupe to topic level — keep the best-scoring chunk per topic.
    const byTopic = new Map<string, { row: any; score: number }>()
    for (const e of fused.values()) {
      const key = e.row.topic || e.row.path
      const cur = byTopic.get(key)
      if (!cur || e.score > cur.score) byTopic.set(key, e)
    }

    return [...byTopic.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row, score }) => ({
        path: row.path,
        topic: row.topic,
        title: row.title,
        heading: row.heading,
        text: row.text,
        kind: row.kind,
        score,
      }))
  }
}
