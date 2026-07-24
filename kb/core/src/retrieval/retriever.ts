// The retrieval adapter behind the MCP tools. The single backend is the LanceDB
// hybrid engine (vector ANN + Intl-segmented FTS + RRF, top-k) — produces
// SearchResult[]. The LanceDB index is built by the writer (`ka kb reindex` /
// distill); this reader opens it lazily and reloads on manifest version bump.
import { join } from 'node:path'
import type { LanceEngine } from './lance-engine.js'
import type { Fts5Engine } from './fts5-engine.js'
import type { Embedder } from './embedder.js'
import type { SearchMode, SearchOptions, SearchResult } from './types.js'

export interface ReindexResult {
  full: boolean
  mode?: SearchMode | 'all'
  changedPaths?: string[]
  removedPaths?: string[]
  rowCount?: number
  docCount?: number
  sourceMtimeMax?: number
  /** Whether a post-reindex compaction ran (B1 auto-optimize). */
  optimized?: boolean
  /** Non-fatal optimize failure message, if compaction threw (the index stays valid). */
  optimizeError?: string
}

export interface Retriever {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  indexAll(): Promise<void>
  /** (Re)build one or both retrieval indexes. */
  reindex?(opts?: { full?: boolean; mode?: SearchMode | 'all' }): Promise<ReindexResult>
  /** Compact + prune the index (reclaim append/MVCC churn). Optional — LanceDB only.
   * `retentionMs` overrides the version-retention margin (0 = deepest clean; used by the
   * one-time cleanup — the default margin keeps a safety window for ongoing compaction). */
  optimize?(retentionMs?: number): Promise<unknown>
  /** Index freshness manifest (version/built_at/counts/status). Optional. */
  indexStatus?(mode?: SearchMode): Promise<import('./manifest.js').IndexManifest | null>
  readonly defaultMode?: SearchMode
}

/** LanceDB index location under the knowledge base. */
export const LANCE_DB_SUBDIR = join('.vectors', 'lancedb')
export const FTS5_DB_SUBDIR = join('.vectors', 'fts5')

export class LanceRetriever implements Retriever {
  private enginePromise: Promise<LanceEngine> | null = null
  private fts5EnginePromise: Promise<Fts5Engine> | null = null
  private embedderInstance: Embedder | null = null

  constructor(
    private readonly kbPath: string,
    private readonly embedder?: Embedder,
    private readonly dbDir?: string,
    readonly defaultMode: SearchMode = 'fts5',
    private readonly fts5DbPath?: string,
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

  /** SQLite is also lazy: embedding-only deployments never even open its file. */
  private fts5Engine(): Promise<Fts5Engine> {
    if (!this.fts5EnginePromise) {
      this.fts5EnginePromise = import('./fts5-engine.js').then(
        ({ Fts5Engine }) => new Fts5Engine(this.fts5DbPath ?? join(this.kbPath, FTS5_DB_SUBDIR, 'kb.sqlite')),
      )
    }
    return this.fts5EnginePromise
  }

  // No-op: the index is (re)built by reindex(); search opens it lazily and reloads
  // on manifest version bump. Keeps MCP/daemon startup fast.
  async indexAll(): Promise<void> {}

  /** Read the index manifest directly (no engine/model load) — for kb_status. */
  async indexStatus(mode: SearchMode = this.defaultMode) {
    const { readManifest, MANIFEST_FILE } = await import('./manifest.js')
    const dir = mode === 'fts5'
      ? (this.fts5DbPath ? join(this.fts5DbPath, '..') : join(this.kbPath, FTS5_DB_SUBDIR))
      : (this.dbDir ?? join(this.kbPath, LANCE_DB_SUBDIR))
    return readManifest(join(dir, MANIFEST_FILE))
  }

  /**
   * (Re)build the index reusing THIS retriever's engine + loaded embedder (so the
   * daemon doesn't reload the 2GB model). Default = incremental (only files changed
   * since the index's source_mtime_max, + drop vanished files); `full` = drop+rebuild.
   */
  async reindex(opts: { full?: boolean; mode?: SearchMode | 'all' } = {}): Promise<ReindexResult> {
    const mode = opts.mode ?? this.defaultMode
    if (mode === 'fts5') return this.reindexFts5(!!opts.full)
    if (mode === 'all') {
      const embedding = await this.reindex({ ...opts, mode: 'embedding' })
      const fts5 = await this.reindex({ ...opts, mode: 'fts5' })
      return {
        ...embedding,
        mode: 'all',
        changedPaths: [...new Set([...(embedding.changedPaths ?? []), ...(fts5.changedPaths ?? [])])],
        removedPaths: [...new Set([...(embedding.removedPaths ?? []), ...(fts5.removedPaths ?? [])])],
      }
    }
    const engine = await this.engine()
    const emb = await this.resolveEmbedder()
    const { reindex, incrementalReindex } = await import('./indexer.js')
    if (opts.full) {
      const b = await reindex(engine, this.kbPath, emb)
      const opt = await this.runOptimize(engine)
      return { full: true, mode: 'embedding', rowCount: b.rows.length, docCount: b.docCount, sourceMtimeMax: b.sourceMtimeMax, ...opt }
    }
    const r = await incrementalReindex(engine, this.kbPath, emb)
    // B1: only compact when the upsert actually mutated rows (skip the common no-op
    // incremental where nothing changed → nothing to reclaim).
    const changed = (r.changedPaths?.length ?? 0) + (r.removedPaths?.length ?? 0) > 0
    const opt = changed ? await this.runOptimize(engine) : {}
    return { full: false, mode: 'embedding', changedPaths: r.changedPaths, removedPaths: r.removedPaths, rowCount: r.rowCount, sourceMtimeMax: r.sourceMtimeMax, ...opt }
  }

  private async reindexFts5(full: boolean): Promise<ReindexResult> {
    const engine = await this.fts5Engine()
    const { reindexFts5, incrementalReindexFts5 } = await import('./fts5-indexer.js')
    const result = full ? reindexFts5(engine, this.kbPath) : incrementalReindexFts5(engine, this.kbPath)
    try {
      engine.optimize()
      return { full, mode: 'fts5', ...result, optimized: true }
    } catch (error) {
      return {
        full,
        mode: 'fts5',
        ...result,
        optimized: false,
        optimizeError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Compact after a mutating reindex (B1). Non-fatal: a failed optimize leaves the
   * index valid (just un-compacted), so we report it instead of failing the reindex. */
  private async runOptimize(engine: LanceEngine): Promise<{ optimized?: boolean; optimizeError?: string }> {
    try {
      await engine.optimize()
      return { optimized: true }
    } catch (e) {
      return { optimized: false, optimizeError: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Public compaction entry (daemon /api/optimize + the one-time cleanup). */
  async optimize(retentionMs?: number): Promise<unknown> {
    if (this.defaultMode === 'fts5') {
      const engine = await this.fts5Engine()
      engine.optimize()
      return null
    }
    const engine = await this.engine()
    return engine.optimize(retentionMs)
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const k = options?.maxResults ?? 5
    const mode = options?.mode ?? this.defaultMode
    try {
      const hits = mode === 'fts5'
        ? (await this.fts5Engine()).search(query, k)
        : await (await this.engine()).search(query, k)
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
  retrieval?: {
    mode?: SearchMode
  }
}

/**
 * Construct the dual-mode retriever. `embedding` preserves the existing LanceDB
 * hybrid behavior; `fts5` is a low-memory lexical backend.
 */
export function createRetriever(
  kbPath: string,
  config: RetrieverConfig,
  opts: { embedder?: Embedder } = {},
): Retriever {
  return new LanceRetriever(kbPath, opts.embedder, undefined, config.retrieval?.mode ?? 'fts5')
}
