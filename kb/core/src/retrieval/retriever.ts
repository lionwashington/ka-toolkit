// The retrieval adapter that keeps the MCP tool signatures unchanged while letting
// the backend be swapped by config. Both backends produce the same SearchResult[]:
//   - KnowledgeRetrieval  → Orama BM25 (current default / fallback)
//   - LanceRetriever      → LanceDB hybrid engine (vector + Intl-FTS + RRF)
// `config.retrieval.engine` selects which. The LanceDB index is built by the writer
// (`ka kb reindex` / distill); this reader opens it lazily and reloads on version bump.
import { join } from 'node:path'
import { KnowledgeRetrieval } from './retrieval.js'
import { LanceEngine } from './lance-engine.js'
import { createEmbedder, type Embedder } from './embedder.js'
import type { SearchOptions, SearchResult } from './types.js'

export interface Retriever {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  indexAll(): Promise<void>
}

/** LanceDB index location under the knowledge base. */
export const LANCE_DB_SUBDIR = join('.vectors', 'lancedb')

export class LanceRetriever implements Retriever {
  readonly engine: LanceEngine

  constructor(kbPath: string, embedder: Embedder, dbDir?: string) {
    this.engine = new LanceEngine(dbDir ?? join(kbPath, LANCE_DB_SUBDIR), embedder)
  }

  // No-op: the index is (re)built by the writer; the reader opens lazily on search
  // and reloads on manifest version bump. Keeps MCP/daemon startup fast.
  async indexAll(): Promise<void> {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const k = options?.maxResults ?? 5
    try {
      const hits = await this.engine.search(query, k)
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
    return new LanceRetriever(kbPath, opts.embedder ?? createEmbedder())
  }
  return new KnowledgeRetrieval(kbPath)
}
