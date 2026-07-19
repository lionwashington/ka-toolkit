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
 * SECURITY: the bot token lives ONLY in this process (read from secrets.yaml
 * channels.telegram.token, in the shared config dir). CC sessions never see it —
 * they only send/receive via MCP. The entry point (channel-core/main.ts) wires
 * this platform into runChannelDaemon().
 */
import { Bot } from 'grammy'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { parse as parseYaml } from 'yaml'
import { parseRoutingPrefix, applyStickyRouting } from '../core/src/routing.ts'
import { resolveTargetToName } from '../core/src/sessions.ts'
import { totalTargetCount } from '../core/src/targets.ts'
import type { Platform, InboundDispatch } from '../core/src/platform.ts'
import { normalizeWorkshopCodexTargets } from '../core/src/workshop-targets.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Data dir holds state.json / channel.log / daemon.pid / attachments/ — the
// daemon's own runtime working files. Defaults to the daemon's own dir (prod:
// ~/.knowledge-assistant/channels/telegram-daemon). KA_DAEMON_DATA_DIR overrides
// it for isolated e2e tests (prod leaves it unset).
const DATA_DIR = process.env.KA_DAEMON_DATA_DIR || __dirname
const STATE_PATH = join(DATA_DIR, 'state.json')
const LOG_PATH = join(DATA_DIR, 'channel.log')
const PID_PATH = join(DATA_DIR, 'daemon.pid')
const ATTACH_DIR = join(DATA_DIR, 'attachments')

// Config dir holds the SHARED config.yaml (non-secret: port/poll_timeout under
// channels.telegram) and secrets.yaml (token/owner_chat_id under the same key) —
// the same two-bucket data layout the rest of ka uses. Resolved exactly like
// common.sh: KA_CONFIG_DIR override, else $KA_HOME/config (KA_HOME default
// ~/.knowledge-assistant). Tests point KA_CONFIG_DIR at a fixture so they
// exercise the real resolution path rather than a separate one.
const CONFIG_DIR = process.env.KA_CONFIG_DIR
  || join(process.env.KA_HOME || join(homedir(), '.knowledge-assistant'), 'config')
const CONFIG_YAML = join(CONFIG_DIR, 'config.yaml')
const SECRETS_YAML = join(CONFIG_DIR, 'secrets.yaml')
const WORKSHOP_YAML = process.env.OPS_CONFIG || join(CONFIG_DIR, 'workshop.yaml')

type Config = {
  http_host: string
  http_port: number
  poll_timeout: number      // getUpdates long-poll seconds (server-side)
  poll_hard_timeout_ms: number  // client-side hard cap on a single getUpdates; 0 = off
  token: string             // bot token (secrets.yaml channels.telegram.token)
  owner_chat_id: string     // only this Telegram user id may reach the daemon
  codex_targets: Array<{ name: string; cwd: string }>
}
type State = {
  offset: number                              // next getUpdates offset = last update_id + 1
  channel_numbers?: Record<string, number>    // stable channel name → number (persisted)
  next_channel_number?: number                // next number to assign
  last_target?: string                        // sticky routing: last single explicit target (no prefix → here)
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { writeFileSync(LOG_PATH, line, { flag: 'a' }) } catch {}
  process.stderr.write(line)
}

// Parse a yaml file into a plain object; missing/empty/malformed → {} (the
// caller fails closed on the absence of required fields, not on a read error).
function readYaml(path: string): any {
  try { return parseYaml(readFileSync(path, 'utf-8')) ?? {} } catch { return {} }
}

function loadConfig(): Config {
  const pub = readYaml(CONFIG_YAML)?.channels?.telegram ?? {}
  const sec = readYaml(SECRETS_YAML)?.channels?.telegram ?? {}
  return {
    http_host: String(pub.host ?? '127.0.0.1'),
    http_port: Number(pub.port ?? 9877),
    poll_timeout: Number(pub.poll_timeout ?? 25),
    // Client-side hard cap so a half-dead TCP socket can't hang the single-threaded
    // pollLoop until the OS TCP timeout (observed: a 9-min inbound outage). Default =
    // long-poll seconds + 10s buffer. Telegram's `timeout` is only a SERVER-side
    // promise to reply within N s — it does nothing if the reply never reaches us.
    poll_hard_timeout_ms: Number(pub.poll_hard_timeout_ms ?? (Number(pub.poll_timeout ?? 25) + 10) * 1000),
    // Secrets (token, owner_chat_id) come ONLY from secrets.yaml — never from
    // config.yaml or the environment. No silent default: an empty token/owner
    // is fail-closed in initTelegram (the daemon refuses to start).
    token: String(sec.token ?? ''),
    owner_chat_id: String(sec.owner_chat_id ?? ''),
    codex_targets: normalizeWorkshopCodexTargets(readYaml(WORKSHOP_YAML)),
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
//
// Each chunk is retried with bounded backoff on transient failures — Telegram
// flood-limits (429, honoring retry_after), 5xx, and network blips — which were
// the suspected cause of replies silently not arriving (a 429 used to surface as
// a hard failure and the message was lost). Non-retryable errors (chat not found,
// bad request) bail immediately and are returned so the caller counts a real
// failure (reply tool → isError + repliesFailed++). "sent" now means delivered
// or genuinely-failed, not "fired once and hoped".
const SEND_MAX_ATTEMPTS = 4
async function sendToTelegram(chatId: string | number, text: string): Promise<string | null> {
  const chunks = chunk(text, MAX_CHUNK_LIMIT, 'newline')
  for (const c of chunks) {
    let lastErr: string | null = null
    for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await bot.api.sendMessage(chatId, c)
        lastErr = null
        break
      } catch (e: any) {
        lastErr = e?.message ?? String(e)
        const code = e?.error_code
        const retryAfter = e?.parameters?.retry_after
        const retryable =
          code === 429 || (typeof code === 'number' && code >= 500) ||
          e?.name === 'HttpError' || /network|socket|timed?out|ECONN|EAI_AGAIN|fetch failed/i.test(lastErr)
        if (!retryable || attempt === SEND_MAX_ATTEMPTS - 1) break
        const waitMs = retryAfter ? (retryAfter * 1000 + 250) : Math.min(1000 * 2 ** attempt, 8000)
        log(`sendMessage retry (attempt ${attempt + 1}/${SEND_MAX_ATTEMPTS}, code=${code ?? '?'}, wait ${waitMs}ms): ${lastErr}`)
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
    if (lastErr) return lastErr // surface → reply isError + repliesFailed++
  }
  return null
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
// 🔴 Bounded retry that does NOT grow the poll budget. getFile/file-fetch hits a
// ~10% transient network "fetch failed" (all attachment kinds — NOT voice-
// specific). A single try silently lost the file; worst for voice, which the
// owner can't naturally re-send (a one-shot spoken utterance is gone for good).
// So we retry — but split the OLD single-try cap into several short tries so the
// single-threaded getUpdates pollLoop (which awaits this on the inbound critical
// path) is not hung any longer than before:
//   old: 1 try × 12s              = 12.0s worst case
//   new: 3 tries × 4s + backoff   = 13.3s worst case  (≈ unchanged)
// A healthy download returns on attempt 1 in <1s — retries only cost wall-clock
// when the network is actually flapping. HTTP 4xx (file gone/too big) is
// permanent → no retry. On total failure we still return '' → text-only delivery
// (message never dropped); offset is already advanced so replay/dedup is intact.
const ATTEMPT_TIMEOUT_MS = 4000
const MAX_DOWNLOAD_ATTEMPTS = 3
const RETRY_BACKOFF_MS = [400, 900]  // wait between attempt 1→2, then 2→3

async function downloadOnce(fileId: string, fileName: string, updateId: number, kind: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS)
  try {
    const file = await bot.api.getFile(fileId, ctrl.signal)
    if (!file.file_path) throw new Error('getFile returned no file_path')
    // File download URL: prod uses api.telegram.org; TELEGRAM_API_ROOT (set only by
    // e2e tests) points it at the mock server. Behavior-preserving when unset.
    const fileBase = process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org'
    const url = `${fileBase}/file/bot${TOKEN}/${file.file_path}`
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) {
      const err: any = new Error(`download http ${res.status}`)
      err.permanent = res.status >= 400 && res.status < 500  // 4xx: file gone/too big — don't retry
      throw err
    }
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(ATTACH_DIR, { recursive: true })
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100) || 'file'
    const dest = join(ATTACH_DIR, `${updateId}-${safe}`)
    writeFileSync(dest, buf)
    log(`attachment saved (${kind}, ${buf.length}B): ${dest}`)
    return dest
  } finally {
    clearTimeout(timer)
  }
}

async function downloadAttachment(fileId: string, fileName: string, updateId: number, kind: string): Promise<string> {
  let lastErr: any
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(fileId, fileName, updateId, kind)
    } catch (e: any) {
      lastErr = e
      const permanent = e?.permanent === true
      const willRetry = attempt < MAX_DOWNLOAD_ATTEMPTS && !permanent
      log(`attachment download attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS} failed (${kind}, ${ATTEMPT_TIMEOUT_MS}ms cap): ${e?.message ?? e}`
        + (permanent ? ' [permanent — no retry]' : willRetry ? ' [will retry]' : ''))
      if (!willRetry) break
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1000)
    }
  }
  log(`attachment download gave up (${kind}) after ${MAX_DOWNLOAD_ATTEMPTS} attempt(s): ${lastErr?.message ?? lastErr} → text-only`)
  return ''
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

  // B4 replay: defer if no runtime target is online — keep offset for replay on reconnect.
  if (totalTargetCount() === 0) {
    log(`(no runtime targets; keeping offset ${state.offset} for replay on reconnect)`)
    return 'stop'
  }

  // B4 dedup truth: advance + persist the offset BEFORE delivery, so a crash or
  // session churn after this point can never re-dispatch the same update_id.
  state.offset = u.update_id + 1
  saveState(state)

  // Routing (sticky) — for an attachment the prefix (and caption) lives in `caption`.
  // An explicit `to X` prefix routes to that list; a BARE message (no prefix) reuses
  // the last single target it was sent to (state.last_target). We record last_target
  // ONLY for a single, non-`all` explicit target — multi-target and `to all` do NOT
  // become sticky. A bare message with no remembered target (first ever) dispatches an
  // EMPTY list; an offline remembered target dispatches that name — both land on the
  // core "pick a channel / not found" prompt (no silent default). Colon has no semantic.
  const routingText = text || caption
  const p = parseRoutingPrefix(routingText)
  const sticky = applyStickyRouting(p, state.last_target)
  const rawTargets = sticky.rawTargets
  // p.body is the content to deliver in EVERY case: prefix-stripped (route), the original
  // (bare), or unquoted (quote-escape). The old `matched ? body : routingText` dropped the
  // quote-escape unwrap (delivered the literal with quotes still in it).
  let content = p.body
  if (sticky.lastTarget !== state.last_target) {
    state.last_target = sticky.lastTarget
    saveState(state)
  }

  // Attachment → local path in meta so the consumer CC can Read it. content falls
  // back to a placeholder with no caption; on download failure deliver text + note.
  let attachmentPath = ''
  if (attachment) {
    attachmentPath = await telegramPlatform.fetchAttachment({ ...attachment, updateId: u.update_id })
    if (!content) content = attachmentPlaceholder(attachment.kind, attachment.fileName)
    if (!attachmentPath) content += '\n (attachment download failed; text only)'
  }

  await inboundDispatch(rawTargets, content, {
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
      // The client-side hard cap that bounds this call lives in grammY's
      // client.timeoutSeconds (set from poll_hard_timeout_ms in initTelegram). A stuck
      // getUpdates aborts there and lands in the catch below, which reconnects on the
      // next iteration (offset NOT advanced → no message lost). Without it grammY would
      // wait out its 500s default and hang inbound for ~8 min.
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
  async startStream(target: string, initialText: string): Promise<unknown> {
    const message = await bot.api.sendMessage(target, initialText)
    return { chatId: target, messageId: message.message_id }
  },
  async updateStream(handle: any, text: string): Promise<string | null> {
    try { await bot.api.editMessageText(handle.chatId, handle.messageId, text); return null }
    catch (error: any) { return error?.message ?? String(error) }
  },
  async finishStream(handle: any, text: string): Promise<string | null> {
    return telegramPlatform.updateStream!(handle, text)
  },
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
  TOKEN = cfg.token
  if (!TOKEN) {
    log(`FATAL: channels.telegram.token is empty in ${SECRETS_YAML} — daemon cannot poll Telegram. Exiting.`)
    process.exit(1)
  }
  if (!cfg.owner_chat_id) {
    log(`FATAL: channels.telegram.owner_chat_id is empty in ${SECRETS_YAML} — cannot filter to the owner. Exiting.`)
    process.exit(1)
  }
  // apiRoot override (env): prod unset → real api.telegram.org; e2e points it at a
  // mock Telegram Bot API for full black-box coverage without real Telegram.
  const apiRoot = process.env.TELEGRAM_API_ROOT
  // grammY's default client.timeoutSeconds is 500 (~8m20s) — THE reason a half-dead
  // socket hung inbound for ~9 min (grammY waited out its own 500s cap). Lower it to
  // poll_hard_timeout_ms so a stuck request aborts (grammY's own AbortSignal) and the
  // pollLoop's catch reconnects on the next iteration. 0 keeps grammY's 500s default.
  const clientOpts: Record<string, any> = {}
  if (apiRoot) clientOpts.apiRoot = apiRoot
  if (cfg.poll_hard_timeout_ms > 0) clientOpts.timeoutSeconds = Math.ceil(cfg.poll_hard_timeout_ms / 1000)
  bot = new Bot(TOKEN, { client: clientOpts })

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
    codex: cfg.codex_targets.length > 0 ? {
      platform: 'telegram' as const,
      bindingsPath: join(DATA_DIR, 'bindings.json'),
      targets: cfg.codex_targets.map(target => ({
        ...target,
        externalChatId: cfg.owner_chat_id,
      })),
      client: process.env.KA_CODEX_APP_SERVER_COMMAND ? {
        command: process.env.KA_CODEX_APP_SERVER_COMMAND,
        args: JSON.parse(process.env.KA_CODEX_APP_SERVER_ARGS_JSON ?? '["app-server"]'),
        env: process.env,
      } : undefined,
    } : undefined,
  }
}

// Standard platform-plugin contract consumed by channel-core/main.ts:
// the universal entry dynamic-imports this module and expects { platform, init }.
export { telegramPlatform as platform, initTelegram as init }

// Pure helpers exported for unit tests (no module-state dependency).
export { chunk, extractAttachment, attachmentPlaceholder }
