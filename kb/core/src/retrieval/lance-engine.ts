// The LanceDB hybrid retrieval engine: vector ANN + Intl-segmented FTS, fused by
// RRF (rank-based, so no score normalization needed — which lets us drop the old
// un-normalized min_score cutoff). Results are de-duped to topic level (best chunk
// per topic) and conversations are down-weighted (they polluted the old ranking).
// MCP tool signatures are unchanged; this lives behind the KnowledgeRetrieval layer.
import * as lancedb from '@lancedb/lancedb'
import { segment } from './segmenter.js'

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

/** Per-kind weight in the fusion — conversations rank below topic files. */
const KIND_WEIGHT: Record<string, number> = { parent: 1, sub: 1, conversation: 0.5 }
const RRF_K = 60

export class LanceEngine {
  private db: lancedb.Connection | null = null
  private tbl: lancedb.Table | null = null

  constructor(
    private readonly dbPath: string,
    private readonly embedder: EngineEmbedder,
    private readonly tableName = 'kb',
  ) {}

  private async conn() {
    if (!this.db) this.db = await lancedb.connect(this.dbPath)
    return this.db
  }

  /** Full rebuild: drop + recreate the table from chunk rows, then build the FTS index. */
  async rebuild(rows: ChunkRow[]): Promise<void> {
    const db = await this.conn()
    try { await db.dropTable(this.tableName) } catch { /* table may not exist */ }
    if (rows.length === 0) { this.tbl = null; return }
    this.tbl = await db.createTable(this.tableName, rows)
    await this.tbl.createIndex('text_seg', { config: lancedb.Index.fts(), replace: true })
  }

  private async table() {
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
