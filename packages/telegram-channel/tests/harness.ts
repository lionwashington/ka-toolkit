// e2e harness: a mock Telegram Bot API server + helpers to spawn the daemon in
// an isolated data dir pointed at the mock (TELEGRAM_API_ROOT), and to connect a
// real MCP client. Lets us characterize the FULL message flow (inbound getUpdates
// → dispatch → MCP notification; reply → sendMessage; cc2cc; 404; status) without
// touching real Telegram or the production daemon.
import express from 'express'
import { createServer, type Server as HttpServer } from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import type { AddressInfo } from 'net'

const PKG_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '')

export type TgUpdate = Record<string, any>

export interface MockTelegram {
  url: string
  port: number
  /** Queue an update to be returned by the next getUpdates poll. */
  push(u: TgUpdate): void
  /** All sendMessage calls the daemon made: {chat_id, text}. */
  sent(): Array<{ chat_id: string; text: string }>
  /** All sendChatAction calls (typing ACKs). */
  chatActions(): Array<{ chat_id: string; action: string }>
  close(): Promise<void>
}

export async function startMockTelegram(): Promise<MockTelegram> {
  const app = express()
  app.use(express.json())
  const pending: TgUpdate[] = []
  const sentMsgs: Array<{ chat_id: string; text: string }> = []
  const actions: Array<{ chat_id: string; action: string }> = []

  // grammy posts to ${apiRoot}/bot<token>/<method>
  app.post('/bot:token/getUpdates', (req, res) => {
    const offset = Number(req.body?.offset ?? 0)
    const ready = pending.filter(u => (u.update_id ?? 0) >= offset)
    if (ready.length > 0) {
      res.json({ ok: true, result: ready })
    } else {
      // No backlog → short delay then empty (mimics long-poll without blocking tests).
      setTimeout(() => res.json({ ok: true, result: [] }), 80)
    }
  })
  app.post('/bot:token/sendMessage', (req, res) => {
    sentMsgs.push({ chat_id: String(req.body?.chat_id ?? ''), text: String(req.body?.text ?? '') })
    res.json({ ok: true, result: { message_id: sentMsgs.length, date: Math.floor(Date.now() / 1000), chat: { id: req.body?.chat_id }, text: req.body?.text } })
  })
  app.post('/bot:token/sendChatAction', (req, res) => {
    actions.push({ chat_id: String(req.body?.chat_id ?? ''), action: String(req.body?.action ?? '') })
    res.json({ ok: true, result: true })
  })
  app.post('/bot:token/getFile', (req, res) => {
    res.json({ ok: true, result: { file_id: req.body?.file_id, file_path: 'mock/file.bin' } })
  })
  // File download (apiRoot-routed when TELEGRAM_API_ROOT is set): return fixed bytes.
  app.get(/^\/file\/bot.*/, (_req, res) => {
    res.setHeader('content-type', 'application/octet-stream')
    res.end(Buffer.from('MOCKIMGBYTES'))
  })
  // anchorOffsetIfFresh uses offset:-1 — handled by the same getUpdates route above.

  const http: HttpServer = createServer(app)
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    push: u => pending.push(u),
    sent: () => sentMsgs,
    chatActions: () => actions,
    close: () => new Promise<void>(r => http.close(() => r())),
  }
}

export interface Daemon {
  port: number
  dataDir: string
  proc: ChildProcess
  baseUrl: string
  stop(): Promise<void>
}

async function getFreePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>(r => srv.close(() => r()))
  return port
}

export async function startDaemon(opts: { apiRoot: string; ownerChatId?: string }): Promise<Daemon> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-daemon-test-'))
  const port = await getFreePort()
  const ownerChatId = opts.ownerChatId ?? '12345'
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    bot_token_env: 'TELEGRAM_BOT_TOKEN',
    http_host: '127.0.0.1',
    http_port: port,
    poll_timeout: 1,
    owner_chat_id: ownerChatId,
  }))
  // Two launch modes, SAME assertions:
  //  - default (source): node --experimental-strip-types channel-core/main.ts,
  //    platform plugin via KA_PLATFORM_MODULE (matches start.sh in source tree).
  //  - bundle (KA_TEST_DAEMON_BUNDLE set): node <bundle>.mjs — the deployed
  //    esbuild artifact (platform baked in). Proves the bundle is behavior-equal.
  const bundle = process.env.KA_TEST_DAEMON_BUNDLE
  let cmd: string[]
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_API_ROOT: opts.apiRoot,
    KA_DAEMON_DATA_DIR: dataDir,
    OWNER_CHAT_ID: ownerChatId,
  }
  if (bundle) {
    cmd = ['node', bundle]
  } else {
    cmd = ['node', '--experimental-strip-types', join(PKG_DIR, '..', 'channel-core', 'src', 'main.ts')]
    env.KA_PLATFORM_MODULE = join(PKG_DIR, 'telegram-platform.ts')
  }
  const proc = spawn(cmd[0], cmd.slice(1), { cwd: PKG_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  // Surface daemon stderr on failure (commented out by default to keep test
  // output clean; uncomment when debugging).
  // proc.stderr?.on('data', d => process.stderr.write(`[daemon] ${d}`))

  const baseUrl = `http://127.0.0.1:${port}`
  // Wait for /api/status to answer.
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/status`)
      if (r.ok) break
    } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  return {
    port, dataDir, proc, baseUrl,
    stop: () => new Promise<void>(resolve => {
      proc.once('exit', () => { try { rmSync(dataDir, { recursive: true, force: true }) } catch {} ; resolve() })
      proc.kill('SIGKILL')
    }),
  }
}

// ── MCP client ──────────────────────────────────────────────────────────────
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface ChannelClient {
  client: Client
  /** notifications/claude/channel payloads received, in order. */
  received: Array<{ content: string; meta: Record<string, string> }>
  close(): Promise<void>
}

export async function connectClient(baseUrl: string, name: string): Promise<ChannelClient> {
  const received: Array<{ content: string; meta: Record<string, string> }> = []
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp?name=${name}`))
  const client = new Client({ name: `test-${name}`, version: '0.0.0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async (n: any) => {
    if (n?.method === 'notifications/claude/channel') {
      received.push({ content: n.params?.content, meta: n.params?.meta })
    }
  }
  await client.connect(transport)
  return {
    client, received,
    close: async () => { try { await client.close() } catch {} },
  }
}

/** Poll until predicate true or timeout. */
export async function waitFor(pred: () => boolean, ms = 4000, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, step))
  }
  return pred()
}
