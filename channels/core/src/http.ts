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
import type { CodexRuntimeManager } from './codex/runtime-manager.ts'
import { runtimeTargetEntries, runtimeTargetOf, targetNames } from './targets.ts'

export function createHttpApp(platform: Platform, runtimeManager?: CodexRuntimeManager) {
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
    const channelName = sanitizeChannelName(reqName)
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

    if (runtimeTargetOf(channelName)) {
      log(`rejecting MCP session for ${channelName}: name is owned by a runtime target`)
      res.status(409).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: `Channel name is already owned by runtime target: ${channelName}` },
        id: (req.body && (req.body as any).id) ?? null,
      })
      return
    }

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
    const runtimeEntries = runtimeTargetEntries()
    const runtimeByName = new Map(runtimeEntries)
    res.json({
      ok: true,
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      mcp_sessions: sessionsById.size,
      fifo_cap_per_name: PER_NAME_FIFO_CAP,
      channels_online: channelCounts,
      active_owners: owners,
      channel_numbers: Object.fromEntries(
        targetNames()
          .map(n => [n, channelNumberOf(n)] as [string, number])
          .sort((a, b) => a[1] - b[1]),
      ),
      sessions: sessionList,
      runtime_targets: runtimeEntries.map(([name, target]) => ({
        name,
        runtime: target.runtime,
        alive: target.isAlive?.() ?? true,
      })),
      dispatches_total: counters.dispatches,
      replies_total: counters.replies,
      replies_failed_total: counters.repliesFailed,
      probe_evicted_total: probeEvictedTotal,
      probe_reconnect_triggered_total: probeReconnectTriggeredTotal,  // M6 self-heals fired
      probes_sent_total: probesSentTotal,
      probe_failures_total: probeFailuresTotal,
      channel_alive: Object.fromEntries(
        targetNames().map(name => {
          const list = byName.get(name) ?? []
          const now = Date.now()
          // alive = a recent ping SUCCEEDED (newly-created sessions get a short
          // creation grace so they aren't reported dead during connect).
          const runtime = runtimeByName.get(name)
          const alive = (runtime?.isAlive?.() ?? !!runtime) || list.some(s =>
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

  app.post('/api/runtimes/codex', async (req, res) => {
    if (!runtimeManager) { res.status(503).json({ ok: false, error: 'Codex runtime routing is unavailable' }); return }
    const name = sanitizeChannelName(req.body?.name)
    const cwd = String(req.body?.cwd ?? '')
    const socketPath = String(req.body?.socket_path ?? '')
    if (!name || !cwd || !socketPath.startsWith('/')) {
      res.status(400).json({ ok: false, error: 'name, cwd, and absolute socket_path are required' }); return
    }
    try {
      await runtimeManager.register({ name, cwd, socketPath })
      res.json({ ok: true, name })
    } catch (error: any) {
      log(`Codex runtime registration failed (${name}): ${error?.message ?? error}`)
      res.status(502).json({ ok: false, error: error?.message ?? String(error) })
    }
  })

  app.delete('/api/runtimes/codex/:name', async (req, res) => {
    if (!runtimeManager) { res.status(503).json({ ok: false, error: 'Codex runtime routing is unavailable' }); return }
    const name = sanitizeChannelName(req.params.name)
    res.json({ ok: true, name, removed: await runtimeManager.unregister(name) })
  })

  // /api/send — deterministic re-send of a reply the MODEL leaked as TEXT instead of
  // emitting a real tool_use (the Opus tool-call-as-text bug). The Stop hook detects
  // that leak, extracts {channel, target, text}, and POSTs here so the owner still
  // gets the message. Goes through the SAME path as the `reply` tool (resolveReplyTarget
  // policy + [#num-name] prefix + platform.send), so the active platform decides HOW to
  // send (telegram bot / lark webhook) — the caller never picks a platform. Loopback-only
  // by virtue of the daemon binding 127.0.0.1 (same as /api/shutdown). NO LLM involved.
  app.post('/api/send', async (req, res) => {
    const { channel, target, text } = (req.body ?? {}) as { channel?: string; target?: string; text?: string }
    const ch = sanitizeChannelName(channel)
    const chatId = String(target ?? '')
    const body = String(text ?? '')
    if (!chatId || !body) { res.status(400).json({ ok: false, error: 'target and text required' }); return }
    const resolved = platform.resolveReplyTarget(chatId)
    if (!resolved) { res.status(403).json({ ok: false, error: `reply target not allowed: ${chatId}` }); return }
    const prefixed = `**[#${channelNumberOf(ch)}-${ch}]** ${body}`
    const err = await platform.send(resolved, prefixed)
    if (err) {
      counters.repliesFailed++
      log(`/api/send FAILED (ch=${ch} → ${resolved}): ${err}`)
      res.status(502).json({ ok: false, error: err }); return
    }
    counters.replies++
    log(`/api/send re-sent leaked reply (ch=${ch} → ${resolved}, hook repair)`)
    res.json({ ok: true, sent: true })
  })

  // Catch-all
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }))

  return app
}
