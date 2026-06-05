// The retrieval adapter behind the MCP tools. The single backend is the LanceDB
// hybrid engine (vector ANN + Intl-segmented FTS + RRF, top-k) — produces
// SearchResult[]. The LanceDB index is built by the writer (`ka kb reindex` /
// distill); this reader opens it lazily and reloads on manifest version bump.
import { join } from 'node:path'
import type { LanceEngine } from './lance-engine.js'
import type { Embedder } from './embedder.js'
import type { SearchOptions, SearchResult } from './types.js'

export interface Retriever {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  indexAll(): Promise<void>
}

/** LanceDB index location under the knowledge base. */
export const LANCE_DB_SUBDIR = join('.vectors', 'lancedb')

export class LanceRetriever implements Retriever {
  private enginePromise: Promise<LanceEngine> | null = null

  constructor(
    private readonly kbPath: string,
    private readonly embedder?: Embedder,
    private readonly dbDir?: string,
  ) {}

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
        const { createEmbedder } = await import('./embedder.js')
        const emb = this.embedder ?? createEmbedder()
        return new LanceEngine(this.dbDir ?? join(this.kbPath, LANCE_DB_SUBDIR), emb)
      })()
    }
    return this.enginePromise
  }

  // No-op: the index is (re)built by the writer; the reader opens lazily on search
  // and reloads on manifest version bump. Keeps MCP/daemon startup fast.
  async indexAll(): Promise<void> {}

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
