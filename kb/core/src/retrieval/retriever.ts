// The retrieval adapter behind the MCP tools. The single backend is the LanceDB
// hybrid engine (vector ANN + Intl-segmented FTS + RRF, top-k) — produces
// SearchResult[]. The LanceDB index is built by the writer (`ka kb reindex` /
// distill); this reader opens it lazily and reloads on manifest version bump.
import { join } from 'node:path'
import type { LanceEngine } from './lance-engine.js'
import type { Embedder } from './embedder.js'
import type { SearchOptions, SearchResult } from './types.js'

export interface ReindexResult {
  full: boolean
  changedPaths?: string[]
  removedPaths?: string[]
  rowCount?: number
  docCount?: number
  sourceMtimeMax?: number
}

export interface Retriever {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  indexAll(): Promise<void>
  /** (Re)build the index. Optional — only the LanceDB retriever supports it. */
  reindex?(opts?: { full?: boolean }): Promise<ReindexResult>
  /** Index freshness manifest (version/built_at/counts/status). Optional. */
  indexStatus?(): Promise<import('./manifest.js').IndexManifest | null>
}

/** LanceDB index location under the knowledge base. */
export const LANCE_DB_SUBDIR = join('.vectors', 'lancedb')

export class LanceRetriever implements Retriever {
  private enginePromise: Promise<LanceEngine> | null = null
  private embedderInstance: Embedder | null = null

  constructor(
    private readonly kbPath: string,
    private readonly embedder?: Embedder,
    private readonly dbDir?: string,
  ) {}

  /** Resolve + cache the embedder (so search and reindex share one loaded model). */
  private async resolveEmbedder(): Promise<Embedder> {
    if (!this.embedderInstance) {
      if (this.embedder) this.embedderInstance = this.embedder
      else { const { createEmbedder } = await import('./embedder.js'); this.embedderInstance = createEmbedder() }
    }
    return this.embedderInstance
  }

  /**
   * Lazily construct the engine via DYNAMIC import. This is the load-bearing
   * boundary: the lancedb engine + fastembed pull in native modules
   * (onnxruntime, lancedb's .node), so keeping them off the static import graph
   * means `import '@ka/core'` loads zero native modules — consumers that never
   * search (cron CLIs, distill, daily-brief) don't pay the model/onnxruntime load.
   * The natives only resolve on the first actual search.
   */
  private engine(): Promise<LanceEngine> {
    if (!this.enginePromise) {
      this.enginePromise = (async () => {
        const { LanceEngine } = await import('./lance-engine.js')
        const emb = await this.resolveEmbedder()
        return new LanceEngine(this.dbDir ?? join(this.kbPath, LANCE_DB_SUBDIR), emb)
      })()
    }
    return this.enginePromise
  }

  // No-op: the index is (re)built by reindex(); search opens it lazily and reloads
  // on manifest version bump. Keeps MCP/daemon startup fast.
  async indexAll(): Promise<void> {}

  /** Read the index manifest directly (no engine/model load) — for kb_status. */
  async indexStatus() {
    const { readManifest, MANIFEST_FILE } = await import('./manifest.js')
    const dir = this.dbDir ?? join(this.kbPath, LANCE_DB_SUBDIR)
    return readManifest(join(dir, MANIFEST_FILE))
  }

  /**
   * (Re)build the index reusing THIS retriever's engine + loaded embedder (so the
   * daemon doesn't reload the 2GB model). Default = incremental (only files changed
   * since the index's source_mtime_max, + drop vanished files); `full` = drop+rebuild.
   */
  async reindex(opts: { full?: boolean } = {}): Promise<ReindexResult> {
    const engine = await this.engine()
    const emb = await this.resolveEmbedder()
    const { reindex, incrementalReindex } = await import('./indexer.js')
    if (opts.full) {
      const b = await reindex(engine, this.kbPath, emb)
      return { full: true, rowCount: b.rows.length, docCount: b.docCount, sourceMtimeMax: b.sourceMtimeMax }
    }
    const r = await incrementalReindex(engine, this.kbPath, emb)
    return { full: false, changedPaths: r.changedPaths, removedPaths: r.removedPaths, rowCount: r.rowCount, sourceMtimeMax: r.sourceMtimeMax }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const k = options?.maxResults ?? 5
    try {
      const engine = await this.engine()
      const hits = await engine.search(query, k)
      return hits.map((h) => ({
        path: h.path,
        title: h.title || h.topic,
        excerpt: h.text.slice(0, 300),
        score: h.score,
        type: h.kind === 'conversation' ? 'conversation' : 'topic',
      }))
    } catch {
      return [] // index not built yet → empty (run `ka kb reindex`)
    }
  }
}

export interface RetrieverConfig {
  retrieval?: unknown
}

/**
 * Construct the retriever. There is a single backend (LanceDB hybrid); the
 * config param is kept for call-site stability and future knobs. An optional
 * embedder lets the daemon share one model across all CCs.
 */
export function createRetriever(
  kbPath: string,
  _config: RetrieverConfig,
  opts: { embedder?: Embedder } = {},
): Retriever {
  return new LanceRetriever(kbPath, opts.embedder)
}
