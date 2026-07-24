// Local, in-process text embedder via fastembed (ONNX runtime, no daemon, no
// cloud — text never leaves the process, privacy G1). Production model =
// multilingual-e5-large (strong Chinese + multilingual, 1024-dim; chosen over
// bge-m3 because bge-m3 only runs through transformers.js, which drags in the
// native `sharp` image lib). e5 is asymmetric: queries and passages get
// different prefixes — fastembed's queryEmbed/passageEmbed handle that, so the
// model swap stays behind this interface.
import { FlagEmbedding, EmbeddingModel } from 'fastembed'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_EMBED_MODEL = EmbeddingModel.MLE5Large // 'fast-multilingual-e5-large'
// MLE5Large is a multi-GB model. fastembed's historical default of 32 makes
// document reindex peak above 3 GB RSS and swap-thrash a 4 GB KA host, starving
// the daemon's HTTP event loop for minutes. Keep production batches deliberately
// small; callers that run on larger machines can opt back up explicitly.
export const DEFAULT_EMBED_BATCH_SIZE = 4

// ONE shared model-cache location. fastembed otherwise defaults to `./local_cache`
// relative to CWD, which spawned a duplicate multi-GB cache per package the embedder
// ran from (repo-root, kb/core, kb/mcp-server). An absolute, CWD-independent default
// collapses those to a single cache. Resolution: opts.cacheDir > $KA_EMBED_CACHE_DIR
// (the deployed daemon points this at its shipped cache) > this user-level default.
export const DEFAULT_EMBED_CACHE_DIR = join(homedir(), '.cache', 'ka-toolkit', 'fastembed')
export function resolveEmbedCacheDir(cacheDir?: string): string {
  return cacheDir ?? process.env.KA_EMBED_CACHE_DIR ?? DEFAULT_EMBED_CACHE_DIR
}

export interface Embedder {
  readonly model: string
  /** Embedding dimension; 0 until the first embed has run. */
  dim(): number
  /** Embed passages/documents (e5 "passage:" prefix applied). */
  embedDocuments(texts: string[]): Promise<number[][]>
  /** Embed a search query (e5 "query:" prefix applied). */
  embedQuery(text: string): Promise<number[]>
}

export interface EmbedderOptions {
  /** fastembed EmbeddingModel value (default multilingual-e5-large). */
  model?: string
  /** Where fastembed caches downloaded ONNX models. */
  cacheDir?: string
  batchSize?: number
}

export function resolveEmbedBatchSize(batchSize?: number, envValue = process.env.KA_EMBED_BATCH_SIZE): number {
  if (Number.isInteger(batchSize) && Number(batchSize) > 0) return Number(batchSize)
  const fromEnv = Number(envValue)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_EMBED_BATCH_SIZE
}

export function createEmbedder(opts: EmbedderOptions = {}): Embedder {
  const model = (opts.model ?? DEFAULT_EMBED_MODEL) as EmbeddingModel
  const batchSize = resolveEmbedBatchSize(opts.batchSize)
  let fe: FlagEmbedding | null = null
  let _dim = 0
  const toArr = (v: ArrayLike<number>) => Array.from(v as Float32Array)

  const cacheDir = resolveEmbedCacheDir(opts.cacheDir)
  const ensure = async () => {
    if (!fe) {
      // fastembed's init() overloads are finicky to satisfy structurally; the runtime
      // accepts { model, cacheDir } — cast past the overload typing.
      const initOpts = { model, cacheDir }
      fe = await FlagEmbedding.init(initOpts as Parameters<typeof FlagEmbedding.init>[0])
    }
    return fe
  }

  return {
    model: String(model),
    dim: () => _dim,
    async embedDocuments(texts) {
      if (texts.length === 0) return []
      const e = await ensure()
      const out: number[][] = []
      for await (const batch of e.passageEmbed(texts, batchSize)) {
        for (const v of batch) {
          const a = toArr(v)
          _dim = a.length
          out.push(a)
        }
        // fastembed/ONNX does native CPU work on the main Node thread. Yield
        // between bounded batches so /api/status and MCP transports stay live
        // during a long incremental reindex.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      return out
    },
    async embedQuery(text) {
      const e = await ensure()
      const v = await e.queryEmbed(text)
      const a = toArr(v)
      _dim = a.length
      return a
    },
  }
}

/** Cosine similarity of two L2-normalized vectors. fastembed returns normalized vectors. */
export function cosine(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
