# kb retrieval — embedding + FTS5 dual-mode search

`kb_search` supports two explicit modes behind the same shared daemon:

- `fts5` (default): SQLite FTS5 lexical search over the same chunks. It uses no
  embedding model, so startup, resident memory and query latency are much lower.
- `embedding`: the existing chunk-level LanceDB hybrid
  engine (vector ANN + Lance FTS + RRF).

Select the default with `retrieval.mode`; a caller may override it per
`kb_search` call with `mode: embedding|fts5`. The remaining MCP tools are
unchanged.

**Only `topics/` is indexed.** Topics are the distilled, structured knowledge —
the retrieval target. Raw `conversations/*.md` are NOT indexed: per memory-system
practice, raw dialogue logs are noisy, redundant, and balloon the index/reindex
cost, so they stay as trace material that distill mines into topics, and retrieval
hits the topics. (If undistilled-recent recall ever matters, the cheap hedge is to
index each daily log's short `## TL;DR` only — not the full log.)

Ground truth: `kb/core/src/retrieval/` (engine) + `kb/mcp-server/src/daemon.ts`
(daemon). Code is authoritative for mechanism.

## Pipelines

```
topics/*.md  (conversations/ NOT indexed — distill mines them into topics)
   └─ chunk (by ## H2, parent/sub aware)
        ├─ embedding mode: "topic › heading" context + multilingual-e5-large
        │    query vector + passage vectors → LanceDB vector ANN + FTS → RRF
        │    → de-dupe to topic → top-k
        │
        └─ fts5 mode: Intl.Segmenter(title + heading + chunk text)
             → SQLite FTS5 unicode61/BM25 → de-dupe to topic → top-k
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
  text into space-joined tokens for both backends. This avoids a native jieba
  dictionary and gives portable Chinese lexical recall.
- **SQLite FTS5** (`fts5-engine.ts`): Node 22's built-in `node:sqlite`, WAL mode,
  atomic full/incremental updates, an independent manifest, and an independent
  `.vectors/fts5/kb.sqlite` file. It never imports fastembed/ONNX/LanceDB.

## Freshness / sync

Indexes are rebuilt out-of-band, never on the read path. Each mode has its own
`index-manifest.json`
(`manifest.ts`) is the single source of truth: `version` / `source_mtime_max` /
`status` / counts. 
- **Reader reload-on-version**: a long-lived reader (the daemon) re-opens the table
  when the manifest version changes — kills in-memory staleness with no restart.
- **Incremental sync**: update only files with `mtime > source_mtime_max` and
  remove vanished paths. Embedding mode re-embeds changed chunks; FTS5 updates
  lexical rows only. `ka kb reindex --mode all` prepares both indexes.
- **Triggers**: if the configured mode has no index, daemon startup builds it once.
  For the default FTS5 mode this is local lexical work and never loads embedding.
  Distill then keeps the configured mode fresh after writing topics. In embedding
  mode the daemon also runs an incremental self-heal on later startups.
- **Fail-loud**: build errors record `status:'error'` in the manifest and re-throw
  — never silently swallowed.

## Shared daemon (kb-retrieval)

One resident process holds a dual-mode retriever and serves every CC over `/mcp`.
With `retrieval.mode: fts5`, the e5 model is not loaded at startup; an explicit
embedding search still loads it lazily.
- Routes: `/mcp`, `/api/status`, `/api/reindex`
  (`?full=1&mode=embedding|fts5|all`), `/api/search` (loopback benchmark), and
  `/api/shutdown`.
- Singleton via fixed loopback port (`retrieval.daemon.{host,port}`, default
  `127.0.0.1:7705`) — a second daemon hits EADDRINUSE and exits cleanly.
- CLI: `ka kb [start|stop|restart|status]`,
  `ka kb reindex [--full] [--mode embedding|fts5|all]`, and
  `ka kb benchmark <fixture> [embedding|fts5|both]`.
- **Session liveness**: a connected CC holds a GET SSE stream open; the daemon idle-evicts
  only sessions whose streams have ALL closed (genuinely disconnected), never a live-but-idle
  CC. This matters because a wrongly-evicted Claude Code drops `kb_search` from its tool list
  and can't re-init until the pane restarts — `ka doctor` flags such coverage gaps.

## Deployment note (native deps)

Embedding mode pulls in native modules (onnxruntime via fastembed, `@lancedb/lancedb`'s
`.node`) that can't be esbuild-bundled into a self-contained file. So the kb MCP +
daemon deploy as an esbuild bundle (with `@ka/core` + all pure-JS deps inlined,
only the 3 native packages external) plus an `npm install` of just those natives
next to it. The retrieval engine is reached via the `@ka/core/retrieval` subpath
behind a dynamic import, so `import '@ka/core'` loads zero native modules —
non-search consumers (cron CLIs, distill, hooks) don't pay the model/onnxruntime
load. See `install.sh` `deploy_kb_mcp()`.

FTS5 adds no deployed npm dependency: it uses the SQLite/FTS5 library included in
the required Node 22.5+ runtime. Node labels
`node:sqlite` experimental, so it may emit one startup warning; the API used here
is covered by unit and daemon integration tests.

Use `ka kb benchmark <fixture> both` to compare quality, latency, CPU and daemon
RSS on a sanitized corpus. Benchmark fixtures and raw results may contain private
knowledge-base information and must remain outside this public repository.
