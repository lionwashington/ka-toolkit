export { loadConfig, loadSecrets, isCaptureChannelAllowed, injectChannels, type KaConfig, type KaSecrets } from './config.js'
export { ConversationCapture } from './capture/capture.js'
export type { Conversation, ConversationMessage, ParseProgress, JsonlEntry, JsonlDelta } from './capture/types.js'
export { readDelta } from './capture/jsonl-reader.js'
export { splitDailyLog } from './daily-log/splitter.js'
export type { SplitResult, SplitOptions } from './daily-log/splitter.js'
export { parseDistillResult } from './distill/result-parser.js'
export type { ParsedDistillResult, ParseOptions as ParseDistillOptions, ParseTier } from './distill/result-parser.js'
export { splitTopic } from './topics/splitter.js'
export type { SplitPlan, SubTopicSpec, SplitOptions as SplitTopicOptions, SplitTopicResult } from './topics/splitter.js'
export { lintKb, fixIndex } from './lint/lint.js'
export type { LintReport, LintFinding, LintOptions, Severity } from './lint/lint.js'
export { KnowledgeStore } from './knowledge-store/store.js'
export type { Topic, TopicSummary, IndexData } from './knowledge-store/types.js'
export { parseFrontmatter, serializeWithFrontmatter } from './knowledge-store/markdown.js'
export type { SearchOptions, SearchResult } from './retrieval/types.js'
// NOTE: the LanceDB hybrid retrieval engine (lance-engine/embedder/indexer) pulls in
// NATIVE modules (onnxruntime via fastembed, @lancedb/lancedb's .node). It is therefore
// NOT re-exported from this main barrel — importing '@ka/core' must stay native-dep-free
// so config/capture/hook/cron consumers bundle clean. Retrieval lives behind the
// subpath '@ka/core/retrieval' (see src/retrieval-index.ts); only the kb MCP + daemon +
// reindex/eval import it (with the native deps available).
export { Distiller } from './distiller/distiller.js'
export type { DistillerPrompt, TopicSuggestion, DistillResult } from './distiller/types.js'
export { WatermarkStore } from './watermark/watermark.js'
export type { SessionWatermark } from './watermark/types.js'
