/**
 * LarkPlatform — the channel-core Platform implementation for Lark.
 *
 * channel-core provides the platform-independent kernel (sessions, routing,
 * dispatch, MCP server, HTTP, probe-M6 + re-adopt reconnect). This module
 * implements the Platform interface — everything Lark-specific:
 *   inbound    : per-group `lark-cli im +chat-messages-list` polling
 *   outbound   : Lark group webhook POST (msg_type=text)
 *   identity   : isSelf = message.sender.id === self_open_id (+ sender_type user)
 *   watermark  : per-chat create_time (MINUTE precision) + message_id dedup
 *   attachment : NONE yet (returns '' → text-only; P3 will add after verifying
 *                lark-cli can fetch message resources — see proposal §6.7)
 *   flavor     : MCP instructions / reply description / status fields
 *
 * SECURITY: only the owner's own messages (sender.id === self_open_id) are ever
 * dispatched (prompt-injection guard). Webhook tokens live ONLY in this process's
 * config.json (gitignored, never in git). The entry (channel-core/main.ts) wires
 * this platform into runChannelDaemon via the { platform, init } contract.
 */
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseRoutingPrefix } from '../channel-core/src/routing.ts'
import { byName, sessionsById, resolveTargetToName } from '../channel-core/src/sessions.ts'
import type { Platform, InboundDispatch } from '../channel-core/src/platform.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Data dir holds config.json / state.json / channel.log / daemon.pid.
// Defaults to the daemon's own dir (prod: ~/.knowledge-assistant/runtime/lark-daemon).
// KA_DAEMON_DATA_DIR overrides it for isolated e2e tests (prod leaves it unset).
const DATA_DIR = process.env.KA_DAEMON_DATA_DIR || __dirname
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const STATE_PATH = join(DATA_DIR, 'state.json')
const LOG_PATH = join(DATA_DIR, 'channel.log')
const PID_PATH = join(DATA_DIR, 'daemon.pid')

type GroupConfig = {
  name: string                       // display name, e.g. "Team Group"
  webhook_url: string                // Lark custom-bot webhook (holds a secret token)
  poll_interval_seconds?: number     // per-group override; falls back to global
}
type Config = {
  self_open_id: string               // only this Lark user (ou_…) may reach the daemon
  poll_interval_seconds: number      // global base poll tick (seconds)
  page_size: number                  // lark-cli chat-messages-list page size
  lark_cli_bin: string               // lark-cli binary (path or $PATH name)
  http_host: string
  http_port: number
  groups: Record<string, GroupConfig> // chatId(oc_…) → group config
}
type State = {
  last_seen_msg_time: Record<string, string>   // per-chat ISO watermark (create_time)
  recent_msg_ids?: Record<string, string[]>    // per-chat last RECENT_IDS_KEEP message_ids
  channel_numbers?: Record<string, number>     // stable channel name → number (persisted)
  next_channel_number?: number
}

const RECENT_IDS_KEEP = 100
const LARK_CLI_TIMEOUT_MS = 30000

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { writeFileSync(LOG_PATH, line, { flag: 'a' }) } catch {}
  process.stderr.write(line)
}

function loadConfig(): Config {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  return {
    // self_open_id: env-first (SELF_OPEN_ID), then config.json — single source.
    self_open_id: String(process.env.SELF_OPEN_ID || raw.self_open_id || ''),
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
    if (!s.last_seen_msg_time) s.last_seen_msg_time = {}
    if (!s.recent_msg_ids) s.recent_msg_ids = {}
    if (!s.channel_numbers) s.channel_numbers = {}
    if (!s.next_channel_number) s.next_channel_number = 1
    return s
  } catch { return empty }
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

// Module-scoped singletons. ASSIGNED IN initLark(), NOT at import time — so unit
// tests can import larkPlatform + pure helpers with zero side effects.
let cfg: Config
let state: State
let lastPollAt = ''
let pollErrors = 0
let running = true
let inboundDispatch: InboundDispatch
// Per-group scheduler bookkeeping.
const groupLastPolledMs: Record<string, number> = {}
const groupInFlight: Record<string, boolean> = {}

// ─────────────────────────── lark-cli spawn (auth via lark-cli's own creds) ─────

// Run `lark-cli <args>` through a login bash so nvm-managed node is on PATH (mirrors
// the old lark daemon). Hard 30s timeout → SIGKILL so a stuck CLI never blocks the
// poll scheduler. Returns the parsed JSON ({ ok, data: { data: { messages } } }).
function runLarkCli(bin: string, args: string[]): Promise<{ ok: boolean; data: any; raw: string }> {
  return new Promise(resolve => {
    const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const child = spawn('bash', ['-lc', `export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ${bin} ${quoted}`])
    let stdout = '', stderr = ''
    child.stdout.on('data', d => (stdout += d.toString()))
    child.stderr.on('data', d => (stderr += d.toString()))
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, data: null, raw: 'timeout' }) }, LARK_CLI_TIMEOUT_MS)
    child.on('close', () => {
      clearTimeout(timer)
      try { const data = JSON.parse(stdout); resolve({ ok: !!data?.ok, data, raw: stdout }) }
      catch { resolve({ ok: false, data: null, raw: stdout || stderr }) }
    })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, data: null, raw: stderr }) })
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

// ─────────────────────────── pure helpers (exported for unit tests) ─────────────

// Lark text content. Card/interactive messages (`<card…>` / `[卡片]`) have no plain
// text → return '' (dropped). `⏎` is Lark's soft line-break char.
export function extractText(content: string | undefined | null): string {
  if (!content || typeof content !== 'string') return ''
  if (content.startsWith('<card') || content.includes('[卡片]')) return ''
  return content.replace(/<card[^>]*>.*?<\/card>/gs, '').replace(/⏎/g, '\n').trim()
}

// Lark create_time → epoch ms. 🔴 create_time is MINUTE precision ("2026-05-20 22:51"),
// so same-minute messages share a timestamp — the watermark uses strict `<` + msgid
// dedup (below) to avoid both re-delivery and same-minute drops.
export function parseLarkTime(t: string): number {
  if (!t) return 0
  const ms = new Date(t.replace(' ', 'T')).getTime()
  return Number.isFinite(ms) ? ms : 0
}

// Remember a delivered message_id per chat (ring of the last RECENT_IDS_KEEP) so a
// same-timestamp re-fetch is not re-delivered. Mutates the passed map; caller persists.
export function rememberMsgId(recent: Record<string, string[]>, chatId: string, mid: string): void {
  if (!mid) return
  const list = recent[chatId] ?? []
  if (list.includes(mid)) return
  list.push(mid)
  if (list.length > RECENT_IDS_KEEP) list.splice(0, list.length - RECENT_IDS_KEEP)
  recent[chatId] = list
}

// ─────────────────────────── outbound: Lark webhook POST (B2) ───────────────────

// Send `text` to a Lark group via its custom-bot webhook. `target` is the group
// chatId; we look up its webhook_url. Returns null on success, else an error string.
// (No chunking: Lark webhook accepts long text, unlike Telegram's 4096 cap.)
async function postToLarkWebhook(target: string, text: string): Promise<string | null> {
  const group = cfg.groups[target]
  if (!group) return `unknown lark group: ${target}`
  try {
    const resp = await fetch(group.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    })
    const body = await resp.text()
    // Lark returns {"code":0,...} on success.
    if (!resp.ok || !body.includes('"code":0')) return `webhook ${resp.status}: ${body.slice(0, 200)}`
    return null
  } catch (e: any) {
    return e?.message ?? String(e)
  }
}

// ─────────────────────────── inbound: per-group polling (B1/B3/B4) ──────────────

// Poll one Lark group: fetch → self-filter → watermark + msgid dedup → route →
// dispatch. Mirrors the telegram handleUpdate contract: persist the watermark
// BEFORE delivery (crash/churn never re-dispatches), and DON'T advance it when
// there are no MCP sessions (offline replay on reconnect).
async function pollGroup(chatId: string, group: GroupConfig): Promise<void> {
  lastPollAt = new Date().toISOString()
  // Watermark is OUR ISO string (set below via toISOString); first poll for a chat
  // defaults to NOW → only deliver messages that arrive after the daemon starts.
  const lastSeenIso = state.last_seen_msg_time[chatId] ?? new Date().toISOString()
  const lastSeenMs = new Date(lastSeenIso).getTime()
  const recent = state.recent_msg_ids ?? (state.recent_msg_ids = {})
  const recentIds = recent[chatId] ?? []

  const msgs = await fetchChatMessages(chatId)
  const queue: { ts: number; sender: string; text: string; mid: string }[] = []
  for (const m of msgs) {
    const sender = m?.sender ?? {}
    // B3 self-filter: only the owner, only real users (not bots).
    if (sender.id !== cfg.self_open_id) continue
    if (sender.sender_type && sender.sender_type !== 'user') continue
    const t = parseLarkTime(m?.create_time ?? '')
    if (!t || t < lastSeenMs) continue          // 🔴 strict < keeps same-minute msgs
    const mid = m?.message_id ?? ''
    if (mid && recentIds.includes(mid)) continue // dedup
    const text = extractText(m?.content)
    if (!text) continue
    queue.push({ ts: t, sender: sender.name ?? 'owner', text, mid })
  }
  queue.sort((a, b) => a.ts - b.ts)             // chronological

  for (const q of queue) {
    // B4 replay: no sessions at all → defer (keep watermark for replay on reconnect).
    if (sessionsById.size === 0) {
      log(`(no MCP sessions; keeping watermark for replay on reconnect, chat=${group.name})`)
      break
    }
    // Dedup truth: record + persist watermark + msgid BEFORE delivery.
    state.last_seen_msg_time[chatId] = new Date(q.ts).toISOString()
    rememberMsgId(recent, chatId, q.mid)
    saveState(state)

    // Routing (prefix in the message text): no prefix → main; `to X:` explicit;
    // `to X` (no colon) only if X online, else main. Same as telegram.
    const p = parseRoutingPrefix(q.text)
    let targetName: string
    let content: string
    const isOnline = (n: string | null): boolean => n === 'all' || (!!n && byName.has(n))
    if (!p.matched) {
      targetName = 'main'; content = q.text
    } else {
      const resolved = resolveTargetToName(p.rawTarget)
      if (p.hadColon) { targetName = resolved ?? `#${p.rawTarget}`; content = p.body }
      else if (isOnline(resolved)) { targetName = resolved as string; content = p.body }
      else { targetName = 'main'; content = q.text }
    }

    await inboundDispatch(targetName, content, {
      chat_id: chatId,            // the Lark group → reply routes back here
      sender_name: q.sender,
      sender_id: cfg.self_open_id,
      message_id: q.mid,
      ts: Math.floor(q.ts / 1000),
    })
  }
}

// Per-group scheduler: a base tick at the global interval; each group polls at its
// own interval, never overlapping itself (groupInFlight guard).
function startPollScheduler(): void {
  const baseTickMs = Math.max(1, cfg.poll_interval_seconds) * 1000
  const tick = (): void => {
    if (!running) return
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
  }
  setInterval(tick, baseTickMs)
}

// ─────────────────────────── the Platform impl ──────────────────────────────────

export const larkPlatform: Platform = {
  name: 'lark',
  send: (target, text) => postToLarkWebhook(target, text),
  // Multi-group policy: reply goes to the group the message came from, IFF it's a
  // configured group (only pre-configured groups are reachable). null → rejected.
  resolveReplyTarget(passedChatId: string): string | null {
    return cfg.groups[passedChatId] ? passedChatId : null
  },
  replyToolDescription: 'Send a text message back to the Lark group it came from (pass the chat_id from the incoming tag).',
  instructions(channelName: string, channelNumber: number): string {
    return `You are running as session channel "[${channelName}]". ` +
      'Incoming channel messages carry a meta tag with the sender info — read it to know how to reply:\n' +
      '• Owner messages from Lark: the owner sent this from a Lark group (they read Lark on phone/laptop, NOT this terminal; your transcript never reaches them). ' +
      'Reply with the `reply` tool, passing the `chat_id` from the tag — it routes back to that same group. Replies are auto-prefixed with ' +
      `**[#${channelNumber}-${channelName}]** so the owner knows which session answered and can route back by number, e.g. \`to ${channelNumber}:\`.\n` +
      '• source="cc": ANOTHER Claude Code session sent this; the tag also has `from_channel=<their channel>`. ' +
      'To answer them, call `send_to_channel` with target=<that from_channel>. Do NOT use `reply` for a cc message (that goes to the Lark group, not the sender).\n' +
      'Reply only when a response is actually warranted — do NOT reflexively bounce a message back (two CCs auto-replying to each other creates an infinite loop). ' +
      'For owner (Lark) messages a reply is normally expected; for cc messages, answer only if you have something to say.'
  },
  statusFields() {
    return { poll_errors_total: pollErrors, last_poll_at: lastPollAt, watermarks: state.last_seen_msg_time }
  },
  isSelf(msg: any): boolean {
    const sender = msg?.sender ?? {}
    return sender.id === cfg.self_open_id && (!sender.sender_type || sender.sender_type === 'user')
  },
  // No attachment support yet (P3, pending lark-cli resource-fetch verification).
  fetchAttachment(_ref: any): Promise<string> {
    return Promise.resolve('')
  },
  startInbound(dispatch: InboundDispatch): void {
    inboundDispatch = dispatch
    const groupCount = Object.keys(cfg.groups).length
    log(`lark per-group polling starting (${groupCount} group(s), base ${cfg.poll_interval_seconds}s)`)
    startPollScheduler()
  },
}

// Load config/state, validate, and return the runChannelDaemon options (everything
// except `platform`). Side effects gated here (not at import) so unit tests stay pure.
export function initLark() {
  cfg = loadConfig()
  state = loadState()
  if (!cfg.self_open_id) {
    log('FATAL: self_open_id is empty (config.json / SELF_OPEN_ID) — cannot filter to owner. Exiting.')
    process.exit(1)
  }
  if (Object.keys(cfg.groups).length === 0) {
    log('WARN: no groups configured — daemon will run but poll nothing until config.json groups are set.')
  }
  return {
    host: cfg.http_host,
    port: cfg.http_port,
    pidPath: PID_PATH,
    logger: log,
    numbering: {
      numbers: state.channel_numbers ?? {},
      next: state.next_channel_number ?? 1,
      persist: (numbers: Record<string, number>, next: number) => {
        state.channel_numbers = numbers
        state.next_channel_number = next
        saveState(state)
      },
    },
  }
}

// Standard platform-plugin contract consumed by channel-core/main.ts.
export { larkPlatform as platform, initLark as init }
