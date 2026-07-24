#!/usr/bin/env node
/**
 * Shared HTTP retrieval daemon (kb-retrieval).
 *
 * One resident process holds a SINGLE retriever — for the lancedb engine that
 * means one LanceDB connection + one embedding model loaded once — and serves
 * every CC over /mcp, instead of each CC spawning its own stdio server (which
 * would load a multi-GB model per CC). The MCP tool surface
 * (kb_search/read_topic/list_topics/status) is byte-identical to the stdio
 * server: each /mcp session just gets a createMcpServer({ retriever }) bound to
 * the shared retriever.
 *
 * Lifecycle mirrors the channel daemon: fixed loopback port as the portable
 * singleton (a second daemon hits EADDRINUSE and exits 0), a pid file, signal
 * handlers, /api/status, and /api/shutdown.
 *
 * This is the type:http backend CCs register against. It is OPT-IN: the stdio
 * entry (index.ts) still works standalone, and nothing registers against this
 * daemon until the cutover (阶段B). Building/deploying it changes no live CC.
 */
import express from 'express'
import type { Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from '@ka/core'
import { createRetriever, SEARCH_MODES, type Retriever, type SearchMode } from '@ka/core/retrieval'
import { createMcpServer } from './index.js'

interface Session {
  transport: StreamableHTTPServerTransport
  lastSeen: number
  // Open long-lived responses for this session — chiefly the GET SSE stream a
  // connected client holds open for server→client messages. A session with ≥1
  // open stream is LIVE (the client is still there, just idle) and must never be
  // idle-evicted; the socket's 'close' event is the reliable disconnect signal.
  streams: Set<ServerResponse>
}

// Session hygiene: HTTP MCP clients (a CC's kb connection) often vanish without a
// clean DELETE, so transport.onclose never fires and sessions pile up forever
// (observed 54 inits / 0 closes → the daemon's event loop eventually jammed). We
// reap zombies, but ONLY ones that are genuinely gone — never a live-but-idle CC.
//
// The original code idle-evicted purely on a wall-clock TTL, on the assumption a
// reaped CC "just re-initializes on its next call". That assumption is FALSE for
// Claude Code: when the server closes its session, the client marks the MCP server
// disconnected and DROPS its tools from the list — so the CC can't make a "next
// call" to trigger re-init, and kb_search silently stays gone until the pane is
// restarted. A connected client keeps a GET SSE stream open; we track those open
// streams per session and only idle-evict a session with ZERO open streams (its
// socket actually closed → reliably gone). Live idle panes are kept indefinitely.
const SESSION_IDLE_TTL_MS = Number(process.env.KB_SESSION_IDLE_TTL_MS) || 15 * 60_000
const SESSION_MAX = Number(process.env.KB_SESSION_MAX) || 48
const SESSION_SWEEP_MS = Number(process.env.KB_SESSION_SWEEP_MS) || 60_000

function makeLogger(stateDir: string): (msg: string) => void {
  const logFile = join(stateDir, 'kb-retrieval.log')
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch {
    // best-effort; logging falls back to stderr below
  }
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    process.stderr.write(line)
    try {
      appendFileSync(logFile, line)
    } catch {
      // non-fatal
    }
  }
}

export async function runRetrievalDaemon(configPath?: string): Promise<Server> {
  const config = loadConfig(configPath)
  const stateDir = config.state_dir
  const host = config.retrieval.daemon.host
  const port = config.retrieval.daemon.port
  const log = makeLogger(stateDir)

  // The ONE shared retriever (LanceDB hybrid). Constructing it sets up the
  // embedder; the model itself loads lazily on the first embed. We warm it below
  // so the first real query isn't slow and so /api/status can report readiness.
  const retriever: Retriever = createRetriever(config.knowledge_base_path, config)
  let ready = false
  let warmError: string | null = null
  let reindexing = false

  installSignalHandlers(log)

  const pidPath = join(stateDir, 'kb-retrieval.pid')
  try {
    writeFileSync(pidPath, String(process.pid))
  } catch (e: any) {
    log(`cannot write pid file ${pidPath}: ${e?.message ?? e}`)
  }

  const sessions = new Map<string, Session>()

  const closeSession = (id: string, why: string) => {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    for (const r of s.streams) { try { r.end() } catch { /* best-effort */ } }
    s.streams.clear()
    try { void s.transport.close() } catch { /* best-effort */ }
    log(`mcp session evicted ${id} (${why}, sessions=${sessions.size})`)
  }
  // Periodic hygiene sweep: drop idle-AND-disconnected sessions + enforce the cap
  // (oldest-first). A session with ≥1 open stream is a live client (idle, but still
  // connected) and is never idle-evicted — only ones whose sockets have all closed.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (s.streams.size === 0 && now - s.lastSeen > SESSION_IDLE_TTL_MS) closeSession(id, 'idle')
    }
    if (sessions.size > SESSION_MAX) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      for (const [id] of oldest.slice(0, sessions.size - SESSION_MAX)) closeSession(id, 'over-cap')
    }
  }, SESSION_SWEEP_MS)
  sweep.unref()

  const app = express()
  app.use(express.json({ limit: '5mb' }))

  app.all('/mcp', async (req, res) => {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
    const existing = sessionId ? sessions.get(sessionId) : undefined
    if (existing) {
      existing.lastSeen = Date.now()
      // Track this response as an open stream: a held-open GET SSE stream keeps the
      // session LIVE (never idle-evicted); short POSTs close right away and drop out.
      // The socket 'close' event is the reliable disconnect signal the SDK's onclose
      // misses for clients that vanish without a clean DELETE.
      const stream = res as unknown as ServerResponse
      existing.streams.add(stream)
      res.on('close', () => existing.streams.delete(stream))
      await existing.transport.handleRequest(req as any, res as any, req.body)
      return
    }

    // New session: only an initialize request may open one. Anything else with an
    // unknown/absent session-id gets 404 so the client re-initializes.
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, lastSeen: Date.now(), streams: new Set() })
          log(`mcp session init ${id} (sessions=${sessions.size})`)
        },
      })
      transport.onclose = () => {
        const id = transport.sessionId
        if (id && sessions.delete(id)) log(`mcp session close ${id} (sessions=${sessions.size})`)
      }
      // Each session gets its own McpServer, all bound to the SHARED retriever
      // (model / LanceDB connection loaded exactly once) and the daemon's config
      // (so the store reads the daemon's KB path, not the default config).
      const server = createMcpServer({ retriever, config })
      await server.connect(transport)
      await transport.handleRequest(req as any, res as any, req.body)
      return
    }

    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found; please reinitialize' },
      id: (req.body && (req.body as any).id) ?? null,
    })
  })

  app.get('/api/status', (_req, res) => {
    const memory = process.memoryUsage()
    const cpu = process.cpuUsage()
    res.json({
      ok: true,
      service: 'kb-retrieval',
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      engine: config.retrieval.mode === 'fts5' ? 'fts5' : 'lancedb',
      search_mode: config.retrieval.mode,
      search_modes: SEARCH_MODES,
      ready,
      warm_error: warmError,
      mcp_sessions: sessions.size,
      knowledge_base_path: config.knowledge_base_path,
      memory: {
        rss_bytes: memory.rss,
        heap_used_bytes: memory.heapUsed,
        external_bytes: memory.external,
      },
      cpu: {
        user_us: cpu.user,
        system_us: cpu.system,
      },
    })
  })

  app.post('/api/shutdown', (_req, res) => {
    log('received /api/shutdown')
    res.json({ ok: true, shutting_down: true })
    // Same as the signal handlers: hard-exit past the onnxruntime/@lancedb atexit
    // destructors (they throw `mutex lock failed` on every shutdown). The 200ms lets
    // the response above flush to the `ka kb stop` caller first.
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 200)
  })

  // (Re)build the index using the ALREADY-LOADED model (no 2GB reload). Default
  // incremental (only files changed since the index's source_mtime_max + drop
  // vanished files); ?full=1 forces a drop+rebuild. distill curls this after
  // writing topics; `ka kb reindex` curls it too. Serialized via `reindexing`.
  app.post('/api/reindex', async (req, res) => {
    if (!retriever.reindex) { res.status(400).json({ ok: false, error: 'reindex not supported by engine' }); return }
    if (reindexing) { res.status(409).json({ ok: false, error: 'reindex already in progress' }); return }
    const full = (req.query as any)?.full === '1' || (req.body && (req.body as any).full === true)
    const requestedMode = String((req.query as any)?.mode ?? (req.body && (req.body as any).mode) ?? config.retrieval.mode)
    if (![...SEARCH_MODES, 'all'].includes(requestedMode as any)) {
      res.status(400).json({ ok: false, error: `invalid mode: ${requestedMode}` })
      return
    }
    const mode = requestedMode as SearchMode | 'all'
    reindexing = true
    try {
      const r = await retriever.reindex({ full: !!full, mode })
      log(`reindex (${full ? 'full' : 'incremental'}, mode=${mode}): changed=${r.changedPaths?.length ?? r.docCount ?? 0} removed=${r.removedPaths?.length ?? 0} rows=${r.rowCount ?? 0} optimized=${r.optimized ?? false}${r.optimizeError ? ` optimizeError=${r.optimizeError}` : ''}`)
      res.json({ ok: true, ...r })
    } catch (e: any) {
      log(`reindex failed: ${e?.message ?? e}`)
      res.json({ ok: false, error: e?.message ?? String(e) })
    } finally {
      reindexing = false
    }
  })

  // Compact + prune the index out-of-band (reclaim append/MVCC churn). Goes through
  // the engine's write gate so it's serialized with reindex + searches wait it out —
  // online-safe, no daemon stop needed. Used by the one-time cleanup and any cron.
  app.post('/api/optimize', async (req, res) => {
    if (!retriever.optimize) { res.status(400).json({ ok: false, error: 'optimize not supported by engine' }); return }
    // Optional ?retention_ms overrides the version-retention margin (0 = deepest clean,
    // for the one-time cleanup; omit → engine default margin, safe for routine compaction).
    const rm = Number((req.query as any)?.retention_ms)
    const retentionMs = Number.isFinite(rm) ? rm : undefined
    try {
      const stats = await retriever.optimize(retentionMs)
      log(`optimize (retention_ms=${retentionMs ?? 'default'}): ${JSON.stringify(stats)}`)
      res.json({ ok: true, stats })
    } catch (e: any) {
      log(`optimize failed: ${e?.message ?? e}`)
      res.json({ ok: false, error: e?.message ?? String(e) })
    }
  })

  // Loopback benchmark/diagnostic endpoint. MCP remains the public tool surface;
  // this returns structured hits so operators can compare the two engines without
  // parsing Markdown tool output.
  app.post('/api/search', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : ''
    const requestedMode = String(req.body?.mode ?? config.retrieval.mode)
    if (!query) { res.status(400).json({ ok: false, error: 'query is required' }); return }
    if (!SEARCH_MODES.includes(requestedMode as SearchMode)) {
      res.status(400).json({ ok: false, error: `invalid mode: ${requestedMode}` })
      return
    }
    const maxResults = Math.max(1, Math.min(50, Number(req.body?.max_results) || config.retrieval.max_results))
    const started = performance.now()
    try {
      const results = await retriever.search(query, {
        maxResults,
        mode: requestedMode as SearchMode,
      })
      res.json({
        ok: true,
        mode: requestedMode,
        elapsed_ms: Number((performance.now() - started).toFixed(3)),
        results,
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }))

  const httpServer = app.listen(port, host, async () => {
    log(`kb-retrieval daemon listening on ${host}:${port}/mcp (pid=${process.pid}, mode=${config.retrieval.mode})`)
    // Become searchable ASAP against the EXISTING configured-mode index. FTS5 opens
    // SQLite and becomes ready without indexing. Embedding mode loads its model via
    // the warmup search, then performs its startup incremental reindex in the
    // background below. Previously embedding reindex + model ran serially BEFORE
    // ready, blocking readiness for minutes and confusing keepalive health checks.
    let didInitialBuild = false
    try {
      const manifest = retriever.indexStatus ? await retriever.indexStatus(config.retrieval.mode) : null
      // A valid zero-row manifest is still an initialized index (for example an
      // intentionally empty KB). Rebuilding is only necessary when the manifest
      // is absent or explicitly unusable.
      const hasIndex = !!manifest && manifest.version > 0 && manifest.status === 'ok'
      // Build the configured mode once when its index does not exist. The default
      // FTS5 build is local lexical work and never imports the embedding stack.
      // Embedding is reached here only when the operator explicitly configured it.
      if (!hasIndex && retriever.reindex) {
        reindexing = true
        try {
          const r = await retriever.reindex({ full: true, mode: config.retrieval.mode })
          log(`initial index build: rows=${r.rowCount ?? 0}`)
          didInitialBuild = true
        } finally {
          reindexing = false
        }
      }
      await retriever.search('warmup', { maxResults: 1, mode: config.retrieval.mode })
      ready = true
      const startupNote = config.retrieval.mode === 'embedding' && !didInitialBuild
        ? '; startup reindex in background'
        : ''
      log(`retriever warm — ready (serving${startupNote})`)
    } catch (e: any) {
      warmError = e?.message ?? String(e)
      log(`retriever warmup failed: ${warmError}`)
    }
    // Embedding-only background self-heal: fold in files changed while the daemon
    // was down. After its one-time missing-index build, FTS5 incremental sync is
    // owned by distill or an explicit `ka kb reindex`.
    if (config.retrieval.mode === 'embedding' && retriever.reindex && !reindexing && !didInitialBuild) {
      reindexing = true
      void retriever.reindex({ mode: config.retrieval.mode })
        .then((r) => log(`startup incremental reindex (background): changed=${r.changedPaths?.length ?? 0} removed=${r.removedPaths?.length ?? 0} rows=${r.rowCount ?? 0}`))
        .catch((e: any) => log(`startup incremental reindex (background) failed: ${e?.message ?? e}`))
        .finally(() => { reindexing = false })
    }
  })

  // Port-bind singleton (same rationale as the channel daemon): no flock on
  // macOS, so the fixed port IS the lock. A second daemon exits cleanly.
  httpServer.on('error', (e: any) => {
    if (e?.code === 'EADDRINUSE') {
      log(`port ${port} already in use — another kb-retrieval daemon is running; exiting`)
      process.exit(0)
    }
    log(`http server error: ${e?.message ?? e}`)
    process.exit(1)
  })

  return httpServer
}

function installSignalHandlers(log: (msg: string) => void): void {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      log(`received ${sig}, exiting`)
      // Hard-exit past native teardown. process.exit(0) runs the onnxruntime /
      // @lancedb atexit destructors, which throw `libc++abi: mutex lock failed:
      // Invalid argument` on every shutdown (observed each SIGTERM). This daemon is
      // stateless — the LanceDB index is on disk, MCP sessions are transient, and the
      // log write above is synchronous (appendFileSync) — so there is nothing to
      // flush; SIGKILL self to die immediately without running those destructors.
      process.kill(process.pid, 'SIGKILL')
    })
  }
  process.on('uncaughtException', (e: any) => {
    log(`uncaughtException: ${e?.message ?? e}\n${e?.stack ?? ''}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (r: any) => {
    log(`unhandledRejection: ${r?.message ?? r}`)
  })
}

// Entrypoint guard: boot ONLY when executed directly. An optional argv[2] is the
// config path (daemon.sh passes the gen3 $KA_HOME/config/config.yaml, since
// @ka/core's loadConfig otherwise defaults to ~/.knowledge-assistant/config.yaml).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRetrievalDaemon(process.argv[2])
}
