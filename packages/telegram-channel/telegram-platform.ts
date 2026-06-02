/**
 * TelegramPlatform — the channel-core Platform implementation for Telegram.
 *
 * channel-core provides the platform-independent kernel (sessions, routing,
 * dispatch, MCP server, HTTP, probe-M6 + reconnect). This module implements the
 * Platform interface — everything Telegram-specific:
 *   inbound    : Bot.api.getUpdates long-poll (single offset cursor)
 *   outbound   : Bot.api.sendMessage(owner_chat_id, …)
 *   identity   : isSelf = update.message.from.id === owner_chat_id
 *   attachment : getFile → download bytes to ATTACH_DIR
 *   flavor     : MCP instructions / reply description / typing ACK / status fields
 *
 * SECURITY: the bot token lives ONLY in this process (process.env[bot_token_env],
 * populated by daemon.sh sourcing <deploy-dir>/.env). CC sessions never see it —
 * they only send/receive via MCP. The entry point (server.ts) wires this platform
 * into runChannelDaemon().
 */
import { Bot } from 'grammy'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseRoutingPrefix } from '../channel-core/src/routing.ts'
import { byName, sessionsById, resolveTargetToName } from '../channel-core/src/sessions.ts'
import type { Platform, InboundDispatch } from '../channel-core/src/platform.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Data dir holds config.json / state.json / channel.log / daemon.pid / attachments/.
// Defaults to the daemon's own dir (prod: ~/.knowledge-assistant/runtime/daemon).
// KA_DAEMON_DATA_DIR overrides it for isolated e2e tests (prod leaves it unset).
const DATA_DIR = process.env.KA_DAEMON_DATA_DIR || __dirname
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const STATE_PATH = join(DATA_DIR, 'state.json')
const LOG_PATH = join(DATA_DIR, 'channel.log')
const PID_PATH = join(DATA_DIR, 'daemon.pid')
const ATTACH_DIR = join(DATA_DIR, 'attachments')

type Config = {
  bot_token_env: string
  http_host: string
  http_port: number
  poll_timeout: number      // getUpdates long-poll seconds
  owner_chat_id: string     // only this Telegram user id may reach the daemon
}
type State = {
  offset: number                              // next getUpdates offset = last update_id + 1
  channel_numbers?: Record<string, number>    // stable channel name → number (persisted)
  next_channel_number?: number                // next number to assign
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { writeFileSync(LOG_PATH, line, { flag: 'a' }) } catch {}
  process.stderr.write(line)
}

function loadConfig(): Config {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  return {
    bot_token_env: raw.bot_token_env ?? 'TELEGRAM_BOT_TOKEN',
    http_host: raw.http_host ?? '127.0.0.1',
    http_port: raw.http_port ?? 9877,
    poll_timeout: raw.poll_timeout ?? 25,
    // owner: env-first (OWNER_CHAT_ID from .env, sourced by daemon.sh), then
    // config.json owner_chat_id as fallback — single secret source in .env.
    owner_chat_id: String(process.env.OWNER_CHAT_ID || raw.owner_chat_id || ''),
  }
}

function loadState(): State {
  const empty: State = { offset: 0, channel_numbers: {}, next_channel_number: 1 }
  if (!existsSync(STATE_PATH)) return empty
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as State
    if (typeof s.offset !== 'number') s.offset = 0
    if (!s.channel_numbers) s.channel_numbers = {}
    if (!s.next_channel_number) s.next_channel_number = 1
    return s
  } catch { return empty }
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

// Module-scoped singletons. ASSIGNED IN initTelegram(), NOT at import time — so
// importing this module for unit tests triggers zero side effects (no config read,
// no token-missing exit, no Bot construction). The Platform methods close over
// these and only run after initTelegram() (called by server.ts main()).
let cfg: Config
let state: State
let OWNER_ID: number
let TOKEN: string
let bot: Bot
let lastPollAt = ''
let pollErrors = 0
let running = true
// The core-bound dispatch handed to startInbound; handleUpdate calls it.
let inboundDispatch: InboundDispatch

// ─────────────────────────── outbound: Telegram sendMessage (B2) ────────────────

// Telegram caps messages at 4096 chars. Split long replies, preferring paragraph
// boundaries when mode is 'newline'. Ported from the official telegram plugin.
const MAX_CHUNK_LIMIT = 4096
function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// Send `text` to a Telegram chat (the owner's DM), chunked. Returns null on
// success, or an error string. Sent as plain text (no parse_mode).
async function sendToTelegram(chatId: string | number, text: string): Promise<string | null> {
  const chunks = chunk(text, MAX_CHUNK_LIMIT, 'newline')
  try {
    for (const c of chunks) {
      await bot.api.sendMessage(chatId, c)
    }
    return null
  } catch (e: any) {
    return e?.message ?? String(e)
  }
}

// ─────────────────────────── inbound attachments (photo/document/…) ─────────────

// Pull the first downloadable attachment off a Telegram message. photo is an
// array of sizes (last = largest). Returns null for a pure-text message.
function extractAttachment(msg: any): { fileId: string; fileName: string; kind: string } | null {
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1]
    return { fileId: largest.file_id, fileName: `${largest.file_unique_id}.jpg`, kind: 'photo' }
  }
  const kinds = ['document', 'video', 'audio', 'voice', 'animation', 'video_note', 'sticker'] as const
  for (const kind of kinds) {
    const a = msg?.[kind]
    if (a?.file_id) {
      const ext = kind === 'voice' ? '.ogg' : kind === 'sticker' ? '.webp' : ''
      return { fileId: a.file_id, fileName: a.file_name || `${a.file_unique_id}${ext}`, kind }
    }
  }
  return null
}

// Human-readable stand-in for `content` when an attachment arrives with no caption.
function attachmentPlaceholder(kind: string, fileName: string): string {
  if (kind === 'photo') return '[image]'
  if (kind === 'sticker') return '[sticker]'
  if (kind === 'voice') return '[voice]'
  if (kind === 'video' || kind === 'video_note') return '[video]'
  if (kind === 'audio') return '[audio]'
  return `[attachment: ${fileName}]`
}

// Resolve file_id → temporary Telegram file_path → download bytes to ATTACH_DIR.
// Returns the local absolute path, or '' on any failure (caller degrades to
// text-only delivery). The bot TOKEN never leaves the daemon.
// 🔴 Hard timeout (DOWNLOAD_TIMEOUT_MS): a slow/stuck fetch must NOT hang the
// single-threaded getUpdates pollLoop (the inbound critical path awaits this). On
// timeout we abort and return '' → text-only delivery (message never dropped);
// offset is already advanced before download so replay/dedup is unaffected.
const DOWNLOAD_TIMEOUT_MS = 12000
async function downloadAttachment(fileId: string, fileName: string, updateId: number, kind: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const file = await bot.api.getFile(fileId, ctrl.signal)
    if (!file.file_path) throw new Error('getFile returned no file_path')
    // File download URL: prod uses api.telegram.org; TELEGRAM_API_ROOT (set only by
    // e2e tests) points it at the mock server. Behavior-preserving when unset.
    const fileBase = process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org'
    const url = `${fileBase}/file/bot${TOKEN}/${file.file_path}`
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`download http ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(ATTACH_DIR, { recursive: true })
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100) || 'file'
    const dest = join(ATTACH_DIR, `${updateId}-${safe}`)
    writeFileSync(dest, buf)
    log(`attachment saved (${kind}, ${buf.length}B): ${dest}`)
    return dest
  } catch (e: any) {
    log(`attachment download failed/timeout (${kind}, ${DOWNLOAD_TIMEOUT_MS}ms cap): ${e?.message ?? e}`)
    return ''
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────── inbound: getUpdates long-poll (B1/B3/B4) ───────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// Handle a single Telegram update. Returns 'stop' when delivery must be deferred
// for replay (owner message but no MCP session) — the caller breaks the batch
// WITHOUT advancing the offset, so the message is re-fetched on reconnect.
async function handleUpdate(u: any): Promise<'ok' | 'stop'> {
  const msg = u?.message
  const text: string = msg?.text ?? ''
  const caption: string = msg?.caption ?? ''
  const fromId: number | undefined = msg?.from?.id
  const attachment = msg ? extractAttachment(msg) : null

  // B3 self filter + empty drop: must be from the owner AND carry text OR a
  // downloadable attachment. Anything else is acked (offset advanced) not dispatched.
  if (!msg || !telegramPlatform.isSelf(msg) || (!text && !attachment)) {
    state.offset = u.update_id + 1
    saveState(state)
    if (msg && !telegramPlatform.isSelf(msg)) log(`drop non-owner update from=${fromId} (acked)`)
    return 'ok'
  }

  // B4 replay: defer if no MCP sessions at all — keep offset for replay on reconnect.
  if (sessionsById.size === 0) {
    log(`(no MCP sessions; keeping offset ${state.offset} for replay on reconnect)`)
    return 'stop'
  }

  // B4 dedup truth: advance + persist the offset BEFORE delivery, so a crash or
  // session churn after this point can never re-dispatch the same update_id.
  state.offset = u.update_id + 1
  saveState(state)

  // Routing — for an attachment the prefix (and caption) lives in `caption`:
  //   - no prefix         → main, full text
  //   - prefix + colon    → explicit routing; route even on miss (feedback)
  //   - prefix, no colon  → only route if target is an ONLINE channel; else → main
  const routingText = text || caption
  const p = parseRoutingPrefix(routingText)
  let targetName: string
  let content: string
  const isOnline = (n: string | null): boolean => n === 'all' || (!!n && byName.has(n))
  if (!p.matched) {
    targetName = 'main'; content = routingText
  } else {
    const resolved = resolveTargetToName(p.rawTarget)
    if (p.hadColon) {
      targetName = resolved ?? `#${p.rawTarget}`
      content = p.body
    } else if (isOnline(resolved)) {
      targetName = resolved as string; content = p.body
    } else {
      targetName = 'main'; content = routingText
    }
  }

  // Attachment → local path in meta so the consumer CC can Read it. content falls
  // back to a placeholder with no caption; on download failure deliver text + note.
  let attachmentPath = ''
  if (attachment) {
    attachmentPath = await telegramPlatform.fetchAttachment({ ...attachment, updateId: u.update_id })
    if (!content) content = attachmentPlaceholder(attachment.kind, attachment.fileName)
    if (!attachmentPath) content += '\n (attachment download failed; text only)'
  }

  await inboundDispatch(targetName, content, {
    chat_id: msg.chat?.id ?? cfg.owner_chat_id,
    sender_name: msg.from?.first_name ?? msg.from?.username ?? 'owner',
    sender_id: fromId,
    message_id: msg.message_id,
    ts: msg.date,
    ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
  })
  return 'ok'
}

// Single long-poll loop (B1).
async function pollLoop(): Promise<void> {
  while (running) {
    let updates: any[] = []
    try {
      updates = await bot.api.getUpdates({
        offset: state.offset,
        timeout: cfg.poll_timeout,
        allowed_updates: ['message'],
      })
    } catch (e: any) {
      pollErrors++
      log(`getUpdates failed: ${e?.message ?? e}`)
      await sleep(3000)
      continue
    }
    lastPollAt = new Date().toISOString()
    if (updates.length > 0) log(`getUpdates: ${updates.length} update(s); next offset=${state.offset}`)
    let deferred = false
    for (const u of updates) {
      const r = await handleUpdate(u)
      if (r === 'stop') { deferred = true; break }
    }
    if (deferred) await sleep(3000)
  }
}

// Anchor on first-ever boot: skip backlog Telegram is still holding so the daemon
// only delivers messages that arrive AFTER it starts. offset=-1 fetches just the
// latest pending update without confirming it; we set offset past it.
async function anchorOffsetIfFresh(): Promise<void> {
  if (existsSync(STATE_PATH)) return  // not a fresh boot — keep persisted offset
  try {
    const latest = await bot.api.getUpdates({ offset: -1, timeout: 0, allowed_updates: ['message'] })
    if (latest.length > 0) {
      state.offset = latest[latest.length - 1].update_id + 1
      saveState(state)
      log(`anchored offset at ${state.offset} (skipped ${latest.length} backlog update(s))`)
    } else {
      saveState(state)
      log(`fresh boot, no backlog; offset starts at ${state.offset}`)
    }
  } catch (e: any) {
    log(`anchor getUpdates failed (will start at offset ${state.offset}): ${e?.message ?? e}`)
  }
}

// ─────────────────────────── the Platform impl ──────────────────────────────────

export const telegramPlatform: Platform = {
  name: 'telegram',
  send: (target, text) => sendToTelegram(target, text),
  // SECURITY: always the configured owner, regardless of the chat_id the session
  // passed — a compromised/injected CC must not reach an arbitrary chat.
  resolveReplyTarget(_passedChatId: string): string | null {
    return cfg.owner_chat_id
  },
  replyToolDescription: 'Send a text message back to the owner via Telegram.',
  instructions(channelName: string, channelNumber: number): string {
    return `You are running as session channel "[${channelName}]". ` +
      'Incoming channel messages carry a meta tag with a `source` field — read it to know who sent it and how to reply:\n' +
      '• source="telegram": the owner sent this from Telegram (they read their phone/laptop, NOT this terminal; your transcript never reaches them). ' +
      'Reply with the `reply` tool, passing the chat_id from the tag. Replies are auto-prefixed with ' +
      `**[#${channelNumber}-${channelName}]** (number-name) so the owner knows which session answered and can route back by number, e.g. \`to ${channelNumber}:\`.\n` +
      '• source="cc": ANOTHER Claude Code session sent this; the tag also has `from_channel=<their channel>`. ' +
      'To answer them, call `send_to_channel` with target=<that from_channel>. Do NOT use `reply` for a cc message (that goes to the owner, not the sender).\n' +
      '• When the meta tag has `attachment_path` (a local absolute file path), the owner sent an image or file — use the Read tool on that path to view it. ' +
      'The `content` is the caption, or a placeholder like "[image]" when the owner sent no caption.\n' +
      'Reply only when a response is actually warranted — do NOT reflexively bounce a message back (two CCs auto-replying to each other creates an infinite loop). ' +
      'For owner (telegram) messages a reply is normally expected; for cc messages, answer only if you have something to say.'
  },
  ackDelivery(target: string): void {
    void bot.api.sendChatAction(target, 'typing').catch(() => {})
  },
  statusFields() {
    return { poll_errors_total: pollErrors, last_poll_at: lastPollAt, offset: state.offset }
  },
  isSelf(msg: any): boolean {
    return msg?.from?.id === OWNER_ID
  },
  fetchAttachment(ref: any): Promise<string> {
    return downloadAttachment(ref.fileId, ref.fileName, ref.updateId, ref.kind)
  },
  async startInbound(dispatch: InboundDispatch): Promise<void> {
    inboundDispatch = dispatch
    await anchorOffsetIfFresh()
    log(`getUpdates long-poll starting (timeout=${cfg.poll_timeout}s, offset=${state.offset})`)
    void pollLoop()
  },
}

// Load config/state, construct the Bot, and return the runChannelDaemon options
// (everything except `platform`). Side effects gated here (not at import) so unit
// tests can import telegramPlatform + pure helpers without booting.
export function initTelegram() {
  cfg = loadConfig()
  state = loadState()
  OWNER_ID = Number(cfg.owner_chat_id)
  TOKEN = process.env[cfg.bot_token_env] ?? ''
  if (!TOKEN) {
    log(`FATAL: env ${cfg.bot_token_env} is empty — daemon cannot poll Telegram. Exiting.`)
    process.exit(1)
  }
  // apiRoot override (env): prod unset → real api.telegram.org; e2e points it at a
  // mock Telegram Bot API for full black-box coverage without real Telegram.
  const apiRoot = process.env.TELEGRAM_API_ROOT
  bot = apiRoot ? new Bot(TOKEN, { client: { apiRoot } }) : new Bot(TOKEN)

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

// Standard platform-plugin contract consumed by channel-core/main.ts:
// the universal entry dynamic-imports this module and expects { platform, init }.
export { telegramPlatform as platform, initTelegram as init }

// Pure helpers exported for unit tests (no module-state dependency).
export { chunk, extractAttachment, attachmentPlaceholder }
