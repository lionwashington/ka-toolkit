# kb retrieval — LanceDB hybrid search (as-built)

How `kb_search` works: a chunk-level **LanceDB hybrid** engine (vector ANN +
Chinese-aware FTS + RRF) served by one shared daemon, kept fresh by incremental
sync. The four MCP tools (`kb_search` / `kb_read_topic` / `kb_list_topics` /
`kb_status`) are the stable surface; everything below is behind them.

**Only `topics/` is indexed.** Topics are the distilled, structured knowledge —
the retrieval target. Raw `conversations/*.md` are NOT indexed: per memory-system
practice, raw dialogue logs are noisy, redundant, and balloon the index/reindex
cost, so they stay as trace material that distill mines into topics, and retrieval
hits the topics. (If undistilled-recent recall ever matters, the cheap hedge is to
index each daily log's short `## TL;DR` only — not the full log.)

Ground truth: `kb/core/src/retrieval/` (engine) + `kb/mcp-server/src/daemon.ts`
(daemon). Code is authoritative for mechanism.

## Pipeline

```
topics/*.md  (conversations/ NOT indexed — distill mines them into topics)
   └─ chunk (by ## H2, parent/sub aware, "topic › heading" prefix)
        └─ embed (multilingual-e5-large, passage side)        ─┐
challenge query ─ embed (query side) ─┐                        │
                                      ▼                        ▼
                       vector ANN  +  Intl-segmented FTS  →  RRF fuse
                          → de-dupe to topic (best chunk) → top-k
```

- **Chunking** (`chunker.ts`): split on `## ` (H2), parent/sub aware, prepend
  `topic › heading` context to each chunk's embed text; the hub auto "Sub-Topic
  Index" section is excluded. Over-budget sections sub-split by paragraph with a
  1-paragraph overlap. This fixes whole-file dilution (the old BM25 indexed entire
  files, so a precise match drowned in the rest of the document).
- **Embedding** (`embedder.ts`): in-process **fastembed** (ONNX runtime, no daemon,
  no cloud — text never leaves the process). Model = **`multilingual-e5-large`**
  (1024-dim, strong Chinese + multilingual). e5 is **asymmetric** — queries and
  passages get different prefixes, handled by `queryEmbed` / `passageEmbed`. One
  shared model-cache dir (`KA_EMBED_CACHE_DIR` > `~/.cache/ka-toolkit/fastembed`).
- **Hybrid search** (`lance-engine.ts`): vector ANN + full-text search fused by
  **RRF** (reciprocal rank fusion, `Σ 1/(k+rank)`, k=60) — rank-based, so there is
  **no `min_score` cutoff**, just top-k. Results are de-duped to one hit per topic
  (best-scoring chunk). (A per-kind weight table remains for parent/sub; since only
  topics are indexed there are no conversation rows to down-weight anymore.)
- **Chinese FTS** (`segmenter.ts`): Node's built-in `Intl.Segmenter` pre-segments
  text into space-joined tokens → LanceDB's default FTS tokenizer. Zero-dependency;
  avoids LanceDB's native jieba dict (a non-portable per-machine install).

## Freshness / sync

The index is rebuilt out-of-band, never on the read path. `index-manifest.json`
(`manifest.ts`) is the single source of truth: `version` / `source_mtime_max` /
`status` / counts. 
- **Reader reload-on-version**: a long-lived reader (the daemon) re-opens the table
  when the manifest version changes — kills in-memory staleness with no restart.
- **Incremental sync** (`indexer.ts` `incrementalReindex`): re-embed only files with
  `mtime > source_mtime_max` (and drop rows for files deleted from disk), then
  `upsert` (delete changed/removed rows → add new → refresh FTS → bump version).
  No-op (no model load, no version bump) when nothing changed.
- **Triggers**: distill calls it after writing topics (so new knowledge is
  searchable in seconds); the daemon also runs an incremental self-heal on startup
  (catches files changed while it was down — mtime-based, so misses self-correct).
- **Fail-loud**: build errors record `status:'error'` in the manifest and re-throw
  — never silently swallowed.

## Shared daemon (kb-retrieval)

One resident process holds a single retriever — one LanceDB connection + the e5
model **loaded once** — and serves every CC over `/mcp` (Streamable HTTP), instead
of each CC spawning its own stdio server (which would load a multi-GB model per CC).
- Routes: `/mcp` (MCP transport), `/api/status`, `/api/reindex` (`?full=1` else
  incremental, serialized), `/api/shutdown`.
- Singleton via fixed loopback port (`retrieval.daemon.{host,port}`, default
  `127.0.0.1:7705`) — a second daemon hits EADDRINUSE and exits cleanly.
- CLI: `ka kb retrieval [start|stop|restart|status]`, `ka kb reindex [--full]`
  (a thin curl to `/api/reindex`).

## Deployment note (native deps)

The engine pulls in native modules (onnxruntime via fastembed, `@lancedb/lancedb`'s
`.node`) that can't be esbuild-bundled into a self-contained file. So the kb MCP +
daemon deploy as an esbuild bundle (with `@ka/core` + all pure-JS deps inlined,
only the 3 native packages external) plus an `npm install` of just those natives
next to it. The retrieval engine is reached via the `@ka/core/retrieval` subpath
behind a dynamic import, so `import '@ka/core'` loads zero native modules —
non-search consumers (cron CLIs, distill, hooks) don't pay the model/onnxruntime
load. See `install.sh` `deploy_kb_mcp()`.
