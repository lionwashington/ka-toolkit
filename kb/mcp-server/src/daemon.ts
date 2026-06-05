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
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from '@ka/core'
import { createRetriever, type Retriever } from '@ka/core/retrieval'
import { createMcpServer } from './index.js'

interface Session {
  transport: StreamableHTTPServerTransport
}

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

  const app = express()
  app.use(express.json({ limit: '5mb' }))

  app.all('/mcp', async (req, res) => {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
    const existing = sessionId ? sessions.get(sessionId) : undefined
    if (existing) {
      await existing.transport.handleRequest(req as any, res as any, req.body)
      return
    }

    // New session: only an initialize request may open one. Anything else with an
    // unknown/absent session-id gets 404 so the client re-initializes.
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport })
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
    res.json({
      ok: true,
      service: 'kb-retrieval',
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      engine: 'lancedb',
      ready,
      warm_error: warmError,
      mcp_sessions: sessions.size,
      knowledge_base_path: config.knowledge_base_path,
    })
  })

  app.post('/api/shutdown', (_req, res) => {
    log('received /api/shutdown')
    res.json({ ok: true, shutting_down: true })
    setTimeout(() => process.exit(0), 200)
  })

  // (Re)build the index using the ALREADY-LOADED model (no 2GB reload). Default
  // incremental (only files changed since the index's source_mtime_max + drop
  // vanished files); ?full=1 forces a drop+rebuild. distill curls this after
  // writing topics; `ka kb reindex` curls it too. Serialized via `reindexing`.
  app.post('/api/reindex', async (req, res) => {
    if (!retriever.reindex) { res.status(400).json({ ok: false, error: 'reindex not supported by engine' }); return }
    if (reindexing) { res.status(409).json({ ok: false, error: 'reindex already in progress' }); return }
    const full = (req.query as any)?.full === '1' || (req.body && (req.body as any).full === true)
    reindexing = true
    try {
      const r = await retriever.reindex({ full: !!full })
      log(`reindex (${full ? 'full' : 'incremental'}): changed=${r.changedPaths?.length ?? r.docCount ?? 0} removed=${r.removedPaths?.length ?? 0} rows=${r.rowCount ?? 0}`)
      res.json({ ok: true, ...r })
    } catch (e: any) {
      log(`reindex failed: ${e?.message ?? e}`)
      res.json({ ok: false, error: e?.message ?? String(e) })
    } finally {
      reindexing = false
    }
  })

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }))

  const httpServer = app.listen(port, host, async () => {
    log(`kb-retrieval daemon listening on ${host}:${port}/mcp (pid=${process.pid}, engine=lancedb)`)
    // Warm + self-heal: an incremental reindex on startup catches any files that
    // changed while the daemon was down (a no-op is cheap and doesn't load the model;
    // changed files get embedded). Then a warmup search loads the model. Serialized
    // via `reindexing` so the /api/reindex endpoint can't race startup.
    try {
      if (retriever.reindex) {
        reindexing = true
        try {
          const r = await retriever.reindex()
          log(`startup incremental reindex: changed=${r.changedPaths?.length ?? 0} removed=${r.removedPaths?.length ?? 0} rows=${r.rowCount ?? 0}`)
        } finally {
          reindexing = false
        }
      }
      await retriever.search('warmup', { maxResults: 1 })
      ready = true
      log('retriever warm — ready')
    } catch (e: any) {
      warmError = e?.message ?? String(e)
      log(`retriever warmup failed: ${warmError}`)
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
      process.exit(0)
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
