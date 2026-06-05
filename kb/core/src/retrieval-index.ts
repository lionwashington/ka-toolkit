// '@ka/core/retrieval' subpath — the LanceDB hybrid retrieval engine. Split out of
// the main '@ka/core' barrel because lance-engine/embedder/indexer statically import
// NATIVE modules (onnxruntime via fastembed, @lancedb/lancedb's .node) that can't be
// esbuild-bundled into the self-contained config/capture/hook bundles. Only the kb MCP
// + kb-retrieval daemon + reindex/eval import from here, where the natives resolve
// (via the deploy's node_modules / --external bundling).
export { createRetriever, LanceRetriever, LANCE_DB_SUBDIR, type Retriever, type ReindexResult } from './retrieval/retriever.js'
export { LanceEngine, type ChunkRow, type SearchHit } from './retrieval/lance-engine.js'
export { createEmbedder, DEFAULT_EMBED_MODEL, DEFAULT_EMBED_CACHE_DIR, resolveEmbedCacheDir, type Embedder } from './retrieval/embedder.js'
export { chunkTopic, type Chunk } from './retrieval/chunker.js'
export { segment } from './retrieval/segmenter.js'
export { buildChunkRows, reindex, incrementalReindex, type BuiltIndex, type IncrementalResult } from './retrieval/indexer.js'
export { readManifest, isStale, type IndexManifest } from './retrieval/manifest.js'
export { evaluate, formatReport, type EvalCase, type EvalReport } from './retrieval/eval.js'
export type { SearchOptions, SearchResult } from './retrieval/types.js'
