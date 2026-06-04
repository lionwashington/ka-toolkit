#!/usr/bin/env node
/**
 * Lark Channel daemon — standalone, decoupled from Claude Code lifecycle.
 *
 * Two-port-on-same-HTTP server (listens on 127.0.0.1:9876):
 *   POST/GET/DELETE  /mcp     — MCP Streamable HTTP transport. Claude Code
 *                                connects here as an MCP client to receive
 *                                Lark message notifications and to call the
 *                                `reply` tool.
 *   GET   /api/status         — JSON daemon health (uptime, sessions, last poll)
 *   POST  /api/shutdown       — graceful shutdown (loopback only)
 *
 * Singleton: flock on .daemon.lock. Second instance exits immediately.
 *
 * Lark polling loop is independent of MCP client connections — even with no
 * Claude session attached, the daemon keeps polling and advances watermarks
 * only when at least one MCP session is connected, so reconnecting clients
 * see the messages they missed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  EmptyResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import express from 'express'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, 'config.json')
const STATE_PATH = join(__dirname, 'state.json')
const LOG_PATH = join(__dirname, 'channel.log')
const PID_PATH = join(__dirname, 'daemon.pid')

type GroupConfig = {
  name: string
  webhook_url: string
  poll_interval_seconds?: number  // per-group override; falls back to global
}
type Config = {
  self_open_id: string
  poll_interval_seconds: number   // global default + base tick granularity
  page_size: number
  lark_cli_bin: string
  http_host: string
  http_port: number
  groups: Record<string, GroupConfig>
}
type State = {
  last_seen_msg_time: Record<string, string>
  recent_msg_ids?: Record<string, string[]>  // last N dispatched message_ids per chat
  channel_numbers?: Record<string, number>   // stable channel name → number (persisted)
  next_channel_number?: number               // next number to assign
}
const RECENT_IDS_KEEP = 100

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { writeFileSync(LOG_PATH, line, { flag: 'a' }) } catch {}
  process.stderr.write(line)
}

function loadConfig(): Config {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  return {
    self_open_id: raw.self_open_id,
    poll_interval_seconds: raw.poll_interval_seconds ?? 5,
    page_size: raw.page_size ?? 10,
    lark_cli_bin: raw.lark_cli_bin ?? 'lark-cli',
    http_host: raw.http_host ?? '127.0.0.1',
    http_port: raw.http_port ?? 9876,
    groups: raw.groups ?? {},
  }
}

function loadState(): State {
  const empty: State = { last_seen_msg_time: {}, recent_msg_ids: {}, channel_numbers: {}, next_channel_number: 1 }
  if (!existsSync(STATE_PATH)) return empty
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as State
    if (!s.recent_msg_ids) s.recent_msg_ids = {}
    if (!s.channel_numbers) s.channel_numbers = {}
    if (!s.next_channel_number) s.next_channel_number = 1
    return s
  } catch { return empty }
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

// Singleton is enforced by `daemon.sh` using the system `flock` binary;
// by the time we get here the lock is already held. No in-node lock needed.

// ─────────────────────────── lark polling ───────────────────────────

const cfg = loadConfig()
const state = loadState()
let lastPollAt: string = ''
let pollErrors = 0

function runLarkCli(bin: string, args: string[]): Promise<{ ok: boolean; data: any; raw: string }> {
  return new Promise(resolve => {
    const child = spawn('bash', [
      '-lc',
      `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && ${bin} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`,
    ])
    let stdout = '', stderr = ''
    child.stdout.on('data', d => (stdout += d.toString()))
    child.stderr.on('data', d => (stderr += d.toString()))
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, data: null, raw: 'timeout' })
    }, 30000)
    child.on('close', () => {
      clearTimeout(timeout)
      try {
        const data = JSON.parse(stdout)
        resolve({ ok: !!data?.ok, data, raw: stdout })
      } catch {
        resolve({ ok: false, data: null, raw: stdout || stderr })
      }
    })
  })
}

async function fetchChatMessages(chatId: string): Promise<any[]> {
  const r = await runLarkCli(cfg.lark_cli_bin, [
    'im', '+chat-messages-list',
    '--chat-id', chatId,
    '--page-size', String(cfg.page_size),
    '--format', 'json',
  ])
  if (!r.ok) return []
  return r.data?.data?.messages ?? []
}

function extractText(content: string | undefined | null): string {
  if (!content || typeof content !== 'string') return ''
  if (content.startsWith('<card') || content.includes('[卡片]')) return ''
  return content.replace(/<card[^>]*>.*?<\/card>/gs, '').replace(/⏎/g, '\n').trim()
}

function parseLarkTime(t: string): number {
  return new Date(t.replace(' ', 'T')).getTime()
}

// Lenient routing-prefix parser. Accepts:
//   prefix `to` (case-insensitive) OR `2` (homophone), optional whitespace,
//   a target token (channel name OR channel number), optional whitespace,
//   optional colon `:`/`：`, optional whitespace, then the body.
// Examples that all parse to target="main": `to main:` `to main` `2main`
//   `2 main` `2 main:` `2 main :` `2  main`. Numeric targets: `to 1:` `to2:`
//   `to 3` `2 1:` → target="1"/"2"/"3" (resolved to a channel by number later).
// Returns matched=false when the text is not a routing attempt at all.
function parseRoutingPrefix(text: string):
  { matched: boolean; hadColon: boolean; rawTarget: string; body: string } {
  const m = text.match(/^\s*(?:to|2)\s*([A-Za-z0-9_-]+)\s*([:：])?\s*/i)
  if (!m) return { matched: false, hadColon: false, rawTarget: '', body: text }
  return {
    matched: true,
    hadColon: !!m[2],
    rawTarget: m[1].toLowerCase(),
    body: text.slice(m[0].length),
  }
}

// ─────────────────────────── MCP server per-session ───────────────────────────

type Session = {
  id: string            // mcp-session-id (UUID)
  server: Server
  transport: StreamableHTTPServerTransport
  name: string          // channel name, e.g. "main", "audit"; lowercased
  createdAt: number     // Date.now() ms (display)
  monoTs: bigint        // process.hrtime.bigint() — nanosecond monotonic, unique sort key
  consecutiveFails: number  // consecutive probe-write failures; evict ≥ PROBE_EVICT_STRIKES
  lastProbeOk: number   // ms timestamp of last successful probe write (0 = never)
}

// Primary store: per-name FIFO list capped at PER_NAME_FIFO_CAP.
//   - New init pushes to the tail; if length exceeds cap, the oldest is shifted out.
//   - Dispatch iterates the list (in parallel) so the dev-channels consumer — which
//     may be on any of the recent sessions — receives the notification.
//   - "Owner" (for display/numbering) = the newest session (list[length-1]).
//   - Retaining ~2 reconnects of sessions tolerates the consumer being on a slightly
//     older connection without losing delivery, while bounding memory.
const PER_NAME_FIFO_CAP = 4
const byName = new Map<string, Session[]>()

// Auxiliary index: incoming HTTP requests carry the mcp-session-id (UUID), not
// the channel name. This map lets us route a request to the right transport.
// It is kept strictly in sync with byName (every byName push/shift updates this).
const sessionsById = new Map<string, Session>()

function addSession(s: Session): void {
  let list = byName.get(s.name)
  if (!list) { list = []; byName.set(s.name, list) }
  list.push(s)
  sessionsById.set(s.id, s)
  while (list.length > PER_NAME_FIFO_CAP) {
    const evicted = list.shift()!
    sessionsById.delete(evicted.id)
    log(`fifo: ${s.name} evict oldest ${evicted.id.slice(0, 8)} (cap=${PER_NAME_FIFO_CAP})`)
    try { void evicted.transport.close?.() } catch {}
  }
  log(`fifo: ${s.name} push ${s.id.slice(0, 8)} (len=${list.length})`)
}

function removeSession(id: string): void {
  const s = sessionsById.get(id)
  if (!s) return
  sessionsById.delete(id)
  const list = byName.get(s.name)
  if (list) {
    const i = list.indexOf(s)
    if (i >= 0) list.splice(i, 1)
    if (list.length === 0) byName.delete(s.name)
  }
  log(`fifo: ${s.name} remove ${id.slice(0, 8)} (len=${byName.get(s.name)?.length ?? 0})`)
}

function ownerOf(name: string): Session | undefined {
  const list = byName.get(name)
  return list && list.length ? list[list.length - 1] : undefined
}

function sessionsOf(name: string): Session[] {
  return byName.get(name) ?? []
}

function allSessions(): Session[] {
  const out: Session[] = []
  for (const list of byName.values()) out.push(...list)
  return out
}

// Stable channel numbers: assigned in first-seen order, persisted in state, reused
// on reconnect. A channel keeps its number even while offline; new names take the
// next free number. Lets the user route by `to 2:` etc. without numbers shifting.
function channelNumberOf(name: string): number {
  if (!state.channel_numbers) state.channel_numbers = {}
  if (state.channel_numbers[name] != null) return state.channel_numbers[name]
  const n = state.next_channel_number ?? 1
  state.channel_numbers[name] = n
  state.next_channel_number = n + 1
  saveState(state)
  return n
}

function nameByNumber(num: number): string | null {
  const cn = state.channel_numbers ?? {}
  for (const [name, n] of Object.entries(cn)) if (n === num) return name
  return null
}

// Resolve a raw routing target (already lowercased) to a channel name.
//   'all'            → 'all' (broadcast sentinel)
//   all-digits       → the channel name with that number, or null if unknown number
//   otherwise        → sanitized channel name string (may or may not be online)
function resolveTargetToName(rawTarget: string): string | null {
  if (rawTarget === 'all') return 'all'
  if (/^\d+$/.test(rawTarget)) return nameByNumber(parseInt(rawTarget, 10))
  return sanitizeChannelName(rawTarget)
}

// Online channels formatted as "name(#num)" for user-facing miss messages.
// Based on distinct names across all live sessions (not just owners).
function onlineChannelListStr(): string {
  const names = Array.from(byName.keys())
  const items = names
    .map(n => ({ n, num: channelNumberOf(n) }))
    .sort((a, b) => a.num - b.num)
    .map(x => `${x.n}(#${x.num})`)
  return items.length ? items.join(', ') : '(no active channel)'
}

function sanitizeChannelName(raw: string | undefined | null): string {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return s || 'main'
}

async function postToLarkWebhook(chatId: string, text: string): Promise<void> {
  const group = cfg.groups[chatId]
  if (!group) return
  try {
    await fetch(group.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    })
  } catch (e: any) {
    log(`postToLarkWebhook failed: ${e?.message ?? e}`)
  }
}

function createMcpServer(channelName: string): Server {
  const s = new Server(
    { name: 'lark-channel', version: '0.6.2' },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions:
        `You are running as session channel "[${channelName}]". ` +
        'The sender reads Lark on their phone or laptop, NOT this terminal. ' +
        'Your transcript output NEVER reaches them — they see only what you send via the `reply` tool. ' +
        'Messages from Lark arrive tagged as <channel source="lark" chat_id="..." sender_name="..." ts="...">. ' +
        'For EVERY incoming channel message, you MUST call the `reply` tool with the chat_id from the tag. ' +
        `Replies are auto-prefixed by the daemon with **[${channelName}]** so the sender knows which session answered.`,
    },
  )

  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'reply',
      description: 'Send a text message back to a Lark group via its webhook bot URL.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Lark chat_id of the group to reply in (oc_xxx).' },
          text: { type: 'string', description: 'Message text. Markdown supported.' },
        },
        required: ['chat_id', 'text'],
      },
    }],
  }))

  s.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name !== 'reply') {
      return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
    const args = (req.params.arguments ?? {}) as { chat_id?: string; text?: string }
    const chatId = args.chat_id ?? ''
    const text = args.text ?? ''
    if (!chatId || !text) {
      return { content: [{ type: 'text', text: 'chat_id and text are required' }], isError: true }
    }
    const group = cfg.groups[chatId]
    if (!group) {
      return { content: [{ type: 'text', text: `unknown chat_id: ${chatId}` }], isError: true }
    }
    const prefixed = `**[${channelName}]** ${text}`
    try {
      const resp = await fetch(group.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: prefixed } }),
      })
      const body = await resp.text()
      if (!resp.ok || !body.includes('"code":0')) {
        log(`reply failed (${chatId}, ch=${channelName}): ${body.slice(0, 200)}`)
        repliesFailedTotal++
        return { content: [{ type: 'text', text: `webhook returned: ${body.slice(0, 200)}` }], isError: true }
      }
      repliesTotal++
      return { content: [{ type: 'text', text: `posted to ${group.name} as [${channelName}]` }] }
    } catch (err: any) {
      log(`reply error: ${err?.message ?? err}`)
      repliesFailedTotal++
      return { content: [{ type: 'text', text: `error: ${err?.message ?? err}` }], isError: true }
    }
  })

  return s
}

// ─────────────────────────── HTTP server ───────────────────────────

const app = express()
app.use(express.json({ limit: '5mb' }))

app.all('/mcp', async (req, res) => {
  const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
  // Diagnostic: log method so we can see whether the client opens a GET (SSE
  // notification stream) vs only POSTs (request channel). No SSE stream = no
  // notifications can ever surface, even though `reply` (a POST) works.
  log(`/mcp ${req.method} sess=${sessionId ? sessionId.slice(0, 8) : '(new)'}`)
  const existing = sessionId ? sessionsById.get(sessionId) : undefined
  if (existing) {
    await existing.transport.handleRequest(req as any, res as any, req.body)
    return
  }
  // Client presented a session-id we don't know (e.g. daemon restarted out from
  // under it). Return 404 so the client treats the session as gone and re-runs
  // the initialize handshake, instead of erroring with "Server not initialized".
  if (sessionId) {
    log(`unknown session-id ${sessionId}; returning 404 to force re-init`)
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found; please reinitialize' },
      id: (req.body && (req.body as any).id) ?? null,
    })
    return
  }
  // New session: read ?name= from URL query (default "main")
  const channelName = sanitizeChannelName((req.query as any)?.name)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => {
      const num = channelNumberOf(channelName)  // assign/reuse stable number
      log(`mcp session init ${id} (channel=${channelName} #${num})`)
      addSession({
        id, server, transport, name: channelName,
        createdAt: Date.now(),
        monoTs: process.hrtime.bigint(),
        consecutiveFails: 0,
        lastProbeOk: 0,
      })
    },
  })
  transport.onclose = () => {
    if (transport.sessionId) {
      log(`mcp session close ${transport.sessionId}`)
      removeSession(transport.sessionId)
    }
  }
  const server = createMcpServer(channelName)
  await server.connect(transport)
  await transport.handleRequest(req as any, res as any, req.body)
})

let dispatchesTotal = 0
let repliesTotal = 0
let repliesFailedTotal = 0
let keepaliveCulledTotal = 0
let routeMissTotal = 0

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
    // channel name → stable number, sorted by number (online owners only)
    channel_numbers: Object.fromEntries(
      Array.from(byName.keys())
        .map(n => [n, channelNumberOf(n)] as [string, number])
        .sort((a, b) => a[1] - b[1]),
    ),
    sessions: sessionList,
    poll_errors_total: pollErrors,
    dispatches_total: dispatchesTotal,
    replies_total: repliesTotal,
    replies_failed_total: repliesFailedTotal,
    keepalive_culled_total: keepaliveCulledTotal,
    probe_evicted_total: probeEvictedTotal,
    probes_sent_total: probesSentTotal,
    probe_failures_total: probeFailuresTotal,
    // per-channel aliveness: channel alive iff ≥1 of its sessions ever probe-succeeded
    // OR was created recently (give new sessions PROBE_INTERVAL_MS grace before probe runs)
    channel_alive: Object.fromEntries(
      Array.from(byName.entries()).map(([name, list]) => {
        const now = Date.now()
        const alive = list.some(s => s.lastProbeOk > 0 || now - s.createdAt < PROBE_INTERVAL_MS * 2)
        return [name, alive]
      }),
    ),
    route_miss_total: routeMissTotal,
    last_poll_at: lastPollAt,
    groups_monitored: Object.keys(cfg.groups).length,
    watermarks: state.last_seen_msg_time,
  })
})

app.get('/api/metrics', (_req, res) => {
  const lines: string[] = []
  const watermarkLag = (iso: string) => {
    const t = new Date(iso).getTime()
    return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 1000)) : 0
  }
  lines.push('# HELP lark_channel_uptime_seconds Daemon uptime in seconds')
  lines.push('# TYPE lark_channel_uptime_seconds gauge')
  lines.push(`lark_channel_uptime_seconds ${Math.floor(process.uptime())}`)
  lines.push('# HELP lark_channel_mcp_sessions Active MCP HTTP sessions')
  lines.push('# TYPE lark_channel_mcp_sessions gauge')
  lines.push(`lark_channel_mcp_sessions ${sessionsById.size}`)
  lines.push('# HELP lark_channel_poll_errors_total Lark poll failures since boot')
  lines.push('# TYPE lark_channel_poll_errors_total counter')
  lines.push(`lark_channel_poll_errors_total ${pollErrors}`)
  lines.push('# HELP lark_channel_dispatches_total Messages dispatched to MCP clients')
  lines.push('# TYPE lark_channel_dispatches_total counter')
  lines.push(`lark_channel_dispatches_total ${dispatchesTotal}`)
  lines.push('# HELP lark_channel_replies_total Reply tool invocations (webhook posts)')
  lines.push('# TYPE lark_channel_replies_total counter')
  lines.push(`lark_channel_replies_total ${repliesTotal}`)
  lines.push('# HELP lark_channel_replies_failed_total Reply webhook failures')
  lines.push('# TYPE lark_channel_replies_failed_total counter')
  lines.push(`lark_channel_replies_failed_total ${repliesFailedTotal}`)
  lines.push('# HELP lark_channel_groups_monitored Number of Lark groups in config')
  lines.push('# TYPE lark_channel_groups_monitored gauge')
  lines.push(`lark_channel_groups_monitored ${Object.keys(cfg.groups).length}`)
  lines.push('# HELP lark_channel_watermark_lag_seconds Time since last_seen for each chat')
  lines.push('# TYPE lark_channel_watermark_lag_seconds gauge')
  for (const [chatId, group] of Object.entries(cfg.groups)) {
    const iso = state.last_seen_msg_time[chatId] ?? ''
    const lag = iso ? watermarkLag(iso) : -1
    const labels = `chat_id="${chatId}",chat_name="${group.name.replace(/"/g, '\\"')}"`
    lines.push(`lark_channel_watermark_lag_seconds{${labels}} ${lag}`)
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(lines.join('\n') + '\n')
})

app.post('/api/shutdown', (_req, res) => {
  log('received /api/shutdown')
  res.json({ ok: true, shutting_down: true })
  setTimeout(() => process.exit(0), 200)
})

// Catch-all
app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }))

// ─────────────────────────── lifecycle hooks ───────────────────────────

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE', 'SIGQUIT'] as const) {
  process.on(sig, () => { log(`received ${sig}, exiting`); process.exit(0) })
}
process.on('uncaughtException', (e: any) => {
  log(`uncaughtException: ${e?.message ?? e}\n${e?.stack ?? ''}`)
  process.exit(1)
})
process.on('unhandledRejection', (r: any) => {
  log(`unhandledRejection: ${r?.message ?? r}\n${r?.stack ?? ''}`)
})
process.on('exit', code => log(`process exit(code=${code})`))

// ─────────────────────────── boot ───────────────────────────

try {
  writeFileSync(PID_PATH, String(process.pid))
} catch (e: any) {
  log(`cannot write pid file: ${e.message}`)
}

const initialAnchor = new Date().toISOString()
let anchored = false
for (const chatId of Object.keys(cfg.groups)) {
  if (!state.last_seen_msg_time[chatId]) {
    state.last_seen_msg_time[chatId] = initialAnchor
    anchored = true
  }
}
if (anchored) {
  saveState(state)
  log(`anchored watermarks at ${initialAnchor}`)
}

function rememberMsgId(chatId: string, mid: string): void {
  if (!mid) return
  if (!state.recent_msg_ids) state.recent_msg_ids = {}
  const list = state.recent_msg_ids[chatId] ?? []
  if (list.includes(mid)) return
  list.push(mid)
  if (list.length > RECENT_IDS_KEEP) list.splice(0, list.length - RECENT_IDS_KEEP)
  state.recent_msg_ids[chatId] = list
}

async function pollGroup(chatId: string, group: GroupConfig): Promise<void> {
  lastPollAt = new Date().toISOString()
  {
    const lastSeenIso = state.last_seen_msg_time[chatId] ?? new Date().toISOString()
    const lastSeenMs = new Date(lastSeenIso).getTime()
    let msgs: any[] = []
    try { msgs = await fetchChatMessages(chatId) }
    catch (e: any) { pollErrors++; log(`fetch failed (${group.name}): ${e?.message ?? e}`); return }

    const recentIds = (state.recent_msg_ids ?? {})[chatId] ?? []
    const queue: { ts: number; sender: string; text: string; mid: string; original: string }[] = []
    for (const m of msgs) {
      const sender = m?.sender ?? {}
      if (sender.id !== cfg.self_open_id) continue
      if (sender.sender_type && sender.sender_type !== 'user') continue
      const t = parseLarkTime(m?.create_time ?? '')
      // Lark create_time is minute-precision so use `<` to keep same-minute messages,
      // and dedupe via message_id since multiple messages can share a timestamp.
      if (!t || t < lastSeenMs) continue
      const mid = m?.message_id ?? ''
      if (mid && recentIds.includes(mid)) continue
      const text = extractText(m?.content)
      if (!text) continue
      queue.push({ ts: t, sender: sender.name ?? 'user', text, mid, original: m?.create_time ?? '' })
    }
    queue.sort((a, b) => a.ts - b.ts)

    for (const q of queue) {
      // Defer if no MCP sessions exist at all — replay on reconnect.
      if (sessionsById.size === 0) {
        log(`(no MCP sessions at all; keeping watermark for replay on reconnect)`)
        break
      }

      // Record this message as seen BEFORE delivery, and persist immediately.
      // This is the single source of dedup truth — guarantees we never dispatch
      // the same message_id twice even if delivery / session churn happens after.
      state.last_seen_msg_time[chatId] = new Date(q.ts).toISOString()
      rememberMsgId(chatId, q.mid)
      saveState(state)

      // Resolve routing target + content per the lenient rules:
      //   - no prefix          → default to main, full text
      //   - prefix + colon     → explicit routing; route even on miss (feedback)
      //   - prefix, no colon   → only route if target matches an ONLINE channel
      //                          (name or number); else treat as normal msg to main
      const p = parseRoutingPrefix(q.text)
      let targetName: string      // 'all' | channel name | display for miss
      let content: string
      const isOnline = (n: string | null): boolean =>
        n === 'all' || (!!n && byName.has(n))
      if (!p.matched) {
        targetName = 'main'; content = q.text
      } else {
        const resolved = resolveTargetToName(p.rawTarget)
        if (p.hadColon) {
          targetName = resolved ?? `#${p.rawTarget}`  // unknown number → readable miss label
          content = p.body
        } else if (isOnline(resolved)) {
          targetName = resolved as string; content = p.body
        } else {
          targetName = 'main'; content = q.text  // lenient fallback: not a real channel
        }
      }

      log(`dispatch (${group.name}) → "${targetName}" [${sessionsById.size} sess]: ${content.slice(0, 60)}`)
      dispatchesTotal++

      // Resolve target sessions: deliver to ALL sessions whose name matches the
      // target (not just the owner). Rationale: Claude Code's dev-channel CONSUMER
      // is bound at process startup to a specific session; after a 404 auto-reconnect
      // the OWNER (newest session) may differ from the consumer-bound session, so
      // owner-only delivery silently fails to surface. Delivering to all same-name
      // sessions guarantees the consumer-bound one receives it; the others (no live
      // consumer) discard silently → surfaces exactly once. `to all:` → every session.
      let targets: Session[]
      if (targetName === 'all') {
        targets = allSessions()
      } else {
        targets = sessionsOf(targetName)
      }

      // No session for this target → notify Lark (skip the notice for broadcast-to-none)
      if (targets.length === 0) {
        if (targetName === 'all') { continue }
        const online = onlineChannelListStr()
        log(`route miss: target=${targetName}, online=${online}`)
        routeMissTotal++
        await postToLarkWebhook(
          chatId,
          `⚠️ channel "${targetName}" is offline\nOnline channels: ${online}\n(message ack'd; target by name or number, e.g. \`to main:\` / \`to 1:\`)`,
        )
        continue
      }

      // Dispatch to every same-name session IN PARALLEL with a per-send timeout.
      // CRITICAL: never await them sequentially — a dormant/half-dead session's
      // notification() can hang on a stale SSE stream and would otherwise block
      // delivery to the LIVE consumer-bound session behind it (head-of-line bug
      // that broke surfacing in the first v0.5.0 cut). Parallel + timeout means a
      // stuck session can't starve the others; the ping loop reaps the dead ones.
      await Promise.allSettled(targets.map(async sess => {
        try {
          await Promise.race([
            sess.server.notification({
              method: 'notifications/claude/channel',
              params: {
                content,
                meta: {
                  chat_id: chatId,
                  chat_name: group.name,
                  sender_name: q.sender,
                  sender_id: cfg.self_open_id,
                  message_id: q.mid,
                  ts: q.original,
                  channel_name: sess.name,
                  routed_target: targetName,
                },
              },
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('notify timeout 5s')), 5000)),
          ])
        } catch (e: any) {
          log(`notification failed for ${sess.name} (ping loop will reap): ${e?.message ?? e}`)
        }
      }))
    }
  }
}

// Per-group polling: each group polls on its own interval (group.poll_interval_seconds
// or the global default). The base tick runs at the global interval (the finest
// granularity); on each tick a group is polled only if its own interval has elapsed.
const groupLastPolledMs: Record<string, number> = {}
const groupInFlight: Record<string, boolean> = {}
const baseTickMs = Math.max(1, cfg.poll_interval_seconds) * 1000
setInterval(() => {
  const now = Date.now()
  for (const [chatId, group] of Object.entries(cfg.groups)) {
    const intervalMs = Math.max(1, group.poll_interval_seconds ?? cfg.poll_interval_seconds) * 1000
    if (groupInFlight[chatId]) continue
    if (now - (groupLastPolledMs[chatId] ?? 0) < intervalMs) continue
    groupLastPolledMs[chatId] = now
    groupInFlight[chatId] = true
    pollGroup(chatId, group)
      .catch(e => { pollErrors++; log(`poll error (${group.name}): ${e?.message ?? e}`) })
      .finally(() => { groupInFlight[chatId] = false })
  }
}, baseTickMs)

// Liveness via write-only probe (v0.6.2). The probe is a fire-and-forget
// `notification` (custom method Claude Code silently ignores); it doesn't need
// a response — we only care whether `transport.send()`'s write to the TCP
// socket succeeds. Dead client = socket closed = write throws synchronously.
//
// RULES (routing/reply policy):
//   1. Probe EVERY session of every channel every 5s — so we can also derive
//      per-channel liveness (channel alive ⇔ ≥1 of its sessions probe-succeeds).
//   2. Eviction strikes: a session is only evicted after CONSECUTIVE_FAIL_LIMIT
//      consecutive write failures (one transient failure isn't enough).
//   3. PROBE_PROTECT_TAIL sessions per name (the newest ones) are NEVER evicted
//      by the probe, regardless of how many failures they accumulate — the live
//      consumer + tool client are likely here, never sacrifice them.
const PROBE_INTERVAL_MS = 5000
const CONSECUTIVE_FAIL_LIMIT = 3
const PROBE_PROTECT_TAIL = 2
let probeEvictedTotal = 0
let probesSentTotal = 0
let probeFailuresTotal = 0
setInterval(async () => {
  for (const [name, list] of Array.from(byName.entries())) {
    if (list.length === 0) continue
    // Indices of sessions immune to probe-eviction (the newest PROBE_PROTECT_TAIL).
    const protectedFromIdx = Math.max(0, list.length - PROBE_PROTECT_TAIL)
    // Iterate by index because we'll need the position to decide immunity.
    for (let i = 0; i < list.length; i++) {
      const sess = list[i]
      const immune = i >= protectedFromIdx
      probesSentTotal++
      try {
        await sess.server.notification({
          method: 'notifications/claude/keepalive',
          params: { t: Date.now() },
        })
        sess.consecutiveFails = 0
        sess.lastProbeOk = Date.now()
      } catch (e: any) {
        sess.consecutiveFails++
        probeFailuresTotal++
        if (!immune && sess.consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
          log(`probe: ${name} ${sess.id.slice(0, 8)} failed ${sess.consecutiveFails}× in a row; evicting: ${e?.message ?? e}`)
          removeSession(sess.id)
          probeEvictedTotal++
        } else if (sess.consecutiveFails === 1 || sess.consecutiveFails % 6 === 0) {
          // log first miss + every 6th (= every 30s under 5s interval) to avoid spam
          log(`probe: ${name} ${sess.id.slice(0, 8)} miss ${sess.consecutiveFails}/${CONSECUTIVE_FAIL_LIMIT}${immune ? ' (immune top-' + PROBE_PROTECT_TAIL + ')' : ''}: ${e?.message ?? e}`)
        }
      }
    }
  }
}, PROBE_INTERVAL_MS)

app.listen(cfg.http_port, cfg.http_host, () => {
  log(`lark-channel daemon listening on ${cfg.http_host}:${cfg.http_port}/mcp (pid=${process.pid})`)
  log(`polling every ${cfg.poll_interval_seconds}s for ${Object.keys(cfg.groups).length} groups`)
})
