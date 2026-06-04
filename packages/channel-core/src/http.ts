// HTTP server (express) — platform-independent. Extracted verbatim from
// telegram-channel/server.ts (R1b-2). Routes:
//   /mcp           — MCP Streamable HTTP transport. Unknown session-id: a consumer
//                    SSE reconnect carrying ?name is RE-ADOPTED (rebuilt, never 404'd —
//                    that's what keeps inbound alive across daemon restarts); any other
//                    unknown id (POST / no ?name) gets 404 so the tool client re-inits.
//   /api/status    — daemon health; platform-specific fields via platform.statusFields()
//   /api/shutdown  — graceful shutdown (loopback)
// createMcpServer is bound to the injected platform. The daemon's main() calls
// app.listen() (+ EADDRINUSE singleton) — kept platform-side so the listen/port
// lifecycle stays with the process owner.
import express from 'express'
import { randomUUID } from 'crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { log } from './log.ts'
import { counters } from './counters.ts'
import { sanitizeChannelName } from './routing.ts'
import {
  PER_NAME_FIFO_CAP, byName, sessionsById, addSession, removeSession, allSessions, channelNumberOf,
} from './sessions.ts'
import {
  CHANNEL_FRESH_MS, PROBE_GRACE_MS,
  probeEvictedTotal, probesSentTotal, probeFailuresTotal, probeReconnectTriggeredTotal,
} from './probe.ts'
import { createMcpServer } from './mcp.ts'
import type { Platform } from './platform.ts'

export function createHttpApp(platform: Platform) {
  const app = express()
  app.use(express.json({ limit: '5mb' }))

  app.all('/mcp', async (req, res) => {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
    // Per-request heartbeat is pure noise (every CC polls every ~5s) — it was
    // ~99% of channel.log. Only emit it under KA_CHANNEL_DEBUG; the meaningful
    // session lifecycle (init / close / re-adopt / 404) is logged below.
    if (process.env.KA_CHANNEL_DEBUG) {
      log(`/mcp ${req.method} sess=${sessionId ? sessionId.slice(0, 8) : '(new)'}`)
    }
    const existing = sessionId ? sessionsById.get(sessionId) : undefined
    if (existing) {
      await existing.transport.handleRequest(req as any, res as any, req.body)
      return
    }
    // A dev-channels CONSUMER reconnecting its notification SSE after a daemon
    // restart is GET-only — it never re-initializes, so a 404 makes it give up and
    // inbound silently dies (meanwhile the tool client re-inits on its own POST 404,
    // so outbound keeps working — that asymmetry IS the bug). The reconnect GET
    // carries ?name=<channel>, so instead of 404 we RE-ADOPT: rebuild a session
    // bound to the SAME stale id + channel and let this GET open its standalone SSE.
    // Inbound comes back with no CC restart and no manual touch.
    // Design principle (agreed): the daemon must NOT 404 a reconnect that tells us
    // its channel — re-adopt it, don't force the client to re-handshake.
    const reqName = (req.query as any)?.name
    const isSseReconnect = req.method === 'GET'
      && String(req.headers['accept'] ?? '').includes('text/event-stream')
      && !!reqName

    // Unknown session-id we can't re-adopt (a POST, or a GET without ?name) → 404 so
    // the tool client re-runs initialize (that path already self-heals on its own).
    if (sessionId && !isSseReconnect) {
      log(`unknown session-id ${sessionId}; returning 404 to force re-init`)
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found; please reinitialize' },
        id: (req.body && (req.body as any).id) ?? null,
      })
      return
    }

    const channelName = sanitizeChannelName(reqName)
    const reuseId = sessionId && isSseReconnect ? sessionId : undefined
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => reuseId ?? randomUUID(),
      onsessioninitialized: id => {
        // Fresh session (POST initialize). Re-adopt registers itself below instead.
        log(`mcp session init ${id} (channel=${channelName} #${channelNumberOf(channelName)})`)
        addSession({
          id, server, transport, name: channelName,
          createdAt: Date.now(), monoTs: process.hrtime.bigint(),
          consecutiveFails: 0, lastProbeOk: 0,
        })
      },
    })
    transport.onclose = () => {
      const id = transport.sessionId ?? reuseId
      if (id) { log(`mcp session close ${id}`); removeSession(id) }
    }
    const server = createMcpServer(channelName, platform)
    await server.connect(transport)

    if (reuseId) {
      // The consumer's GET is NOT an initialize handshake, so the SDK transport
      // would reject it ("Server not initialized"). Pre-seed it as an already-
      // initialized session bound to the stale id, register it so dispatch fanout
      // reaches it, THEN let the GET open the standalone SSE. (The consumer is
      // already initialized client-side — it just wants its stream back.)
      const wst = (transport as any)._webStandardTransport
      if (wst) { wst.sessionId = reuseId; wst._initialized = true }
      addSession({
        id: reuseId, server, transport, name: channelName,
        createdAt: Date.now(), monoTs: process.hrtime.bigint(),
        consecutiveFails: 0, lastProbeOk: 0,
      })
      log(`mcp session RE-ADOPT ${reuseId} (channel=${channelName} #${channelNumberOf(channelName)}) — consumer SSE reconnect, no 404`)
    }

    await transport.handleRequest(req as any, res as any, req.body)
  })

  app.get('/api/status', (_req, res) => {
    const all = allSessions()
    const sessionList = all.map(s => ({
      id: s.id, name: s.name, age_seconds: Math.floor((Date.now() - s.createdAt) / 1000),
    }))
    const channelCounts: Record<string, number> = {}
    for (const [name, list] of byName) channelCounts[name] = list.length
    const owners: Record<string, string> = {}
    for (const [name, list] of byName) if (list.length) owners[name] = list[list.length - 1].id.slice(0, 8)
    res.json({
      ok: true,
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      mcp_sessions: sessionsById.size,
      fifo_cap_per_name: PER_NAME_FIFO_CAP,
      channels_online: channelCounts,
      active_owners: owners,
      channel_numbers: Object.fromEntries(
        Array.from(byName.keys())
          .map(n => [n, channelNumberOf(n)] as [string, number])
          .sort((a, b) => a[1] - b[1]),
      ),
      sessions: sessionList,
      dispatches_total: counters.dispatches,
      replies_total: counters.replies,
      replies_failed_total: counters.repliesFailed,
      probe_evicted_total: probeEvictedTotal,
      probe_reconnect_triggered_total: probeReconnectTriggeredTotal,  // M6 self-heals fired
      probes_sent_total: probesSentTotal,
      probe_failures_total: probeFailuresTotal,
      channel_alive: Object.fromEntries(
        Array.from(byName.entries()).map(([name, list]) => {
          const now = Date.now()
          // alive = a recent ping SUCCEEDED (newly-created sessions get a short
          // creation grace so they aren't reported dead during connect).
          const alive = list.some(s =>
            (s.lastProbeOk > 0 && now - s.lastProbeOk < CHANNEL_FRESH_MS) ||
            (s.lastProbeOk === 0 && now - s.createdAt < PROBE_GRACE_MS))
          return [name, alive]
        }),
      ),
      route_miss_total: counters.routeMiss,
      cc_dispatches_total: counters.ccDispatches,
      // platform-specific fields (telegram: offset / poll health; lark: per-chat watermark …)
      ...(platform.statusFields?.() ?? {}),
    })
  })

  app.post('/api/shutdown', (_req, res) => {
    log('received /api/shutdown')
    res.json({ ok: true, shutting_down: true })
    setTimeout(() => process.exit(0), 200)
  })

  // Catch-all
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }))

  return app
}
