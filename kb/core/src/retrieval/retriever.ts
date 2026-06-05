// The retrieval adapter that keeps the MCP tool signatures unchanged while letting
// the backend be swapped by config. Both backends produce the same SearchResult[]:
//   - KnowledgeRetrieval  → Orama BM25 (current default / fallback)
//   - LanceRetriever      → LanceDB hybrid engine (vector + Intl-FTS + RRF)
// `config.retrieval.engine` selects which. The LanceDB index is built by the writer
// (`ka kb reindex` / distill); this reader opens it lazily and reloads on version bump.
import { join } from 'node:path'
import { KnowledgeRetrieval } from './retrieval.js'
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
   * lets the orama default path (and its self-contained esbuild bundle) stay
   * free of native deps — they only resolve when the lancedb backend is used.
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
  retrieval?: { engine?: string }
}

/** Pick the retrieval backend from config (default orama; lancedb opt-in). */
export function createRetriever(
  kbPath: string,
  config: RetrieverConfig,
  opts: { embedder?: Embedder } = {},
): Retriever {
  if (config.retrieval?.engine === 'lancedb') {
    return new LanceRetriever(kbPath, opts.embedder)
  }
  return new KnowledgeRetrieval(kbPath)
}
