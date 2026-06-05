// Local, in-process text embedder via fastembed (ONNX runtime, no daemon, no
// cloud — text never leaves the process, privacy G1). Production model =
// multilingual-e5-large (strong Chinese + multilingual, 1024-dim; chosen over
// bge-m3 because bge-m3 only runs through transformers.js, which drags in the
// native `sharp` image lib). e5 is asymmetric: queries and passages get
// different prefixes — fastembed's queryEmbed/passageEmbed handle that, so the
// model swap stays behind this interface.
import { FlagEmbedding, EmbeddingModel } from 'fastembed'

export const DEFAULT_EMBED_MODEL = EmbeddingModel.MLE5Large // 'fast-multilingual-e5-large'

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

export function createEmbedder(opts: EmbedderOptions = {}): Embedder {
  const model = (opts.model ?? DEFAULT_EMBED_MODEL) as EmbeddingModel
  const batchSize = opts.batchSize ?? 32
  let fe: FlagEmbedding | null = null
  let _dim = 0
  const toArr = (v: ArrayLike<number>) => Array.from(v as Float32Array)

  const ensure = async () => {
    if (!fe) {
      fe = await FlagEmbedding.init({
        model,
        ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
      })
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
