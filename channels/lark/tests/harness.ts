// e2e harness for lark-channel: a mock Lark webhook server (captures outbound),
// a fake lark-cli (canned inbound JSON), and helpers to spawn the daemon in an
// isolated data dir + connect a real MCP client. Characterizes the FULL flow
// (inbound lark-cli poll → dispatch → MCP notification; reply → webhook POST;
// self-filter; minute-precision dedup) without real Lark / lark-cli.
import express from 'express'
import { createServer, type Server as HttpServer } from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import type { AddressInfo } from 'net'

const PKG_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '')
const REPO = join(PKG_DIR, '..', '..')

export interface MockWebhook {
  url: string
  /** All webhook POST bodies the daemon sent: {text}. */
  sent(): Array<{ text: string }>
  close(): Promise<void>
}

export async function startMockWebhook(): Promise<MockWebhook> {
  const app = express()
  app.use(express.json())
  const posts: Array<{ text: string }> = []
  app.post('/hook/:token', (req, res) => {
    posts.push({ text: String(req.body?.content?.text ?? '') })
    res.json({ code: 0, msg: 'success' })
  })
  const http: HttpServer = createServer(app)
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/hook/test-token`,
    sent: () => posts,
    close: () => new Promise<void>(r => http.close(() => r())),
  }
}

export interface Daemon {
  port: number
  dataDir: string
  mockDir: string
  proc: ChildProcess
  baseUrl: string
  /** Queue lark-cli messages for a chat (the fake CLI emits them on next poll). */
  pushMessages(chatId: string, messages: any[]): void
  stop(): Promise<void>
}

async function getFreePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>(r => srv.close(() => r()))
  return port
}

export async function startDaemon(opts: {
  webhookUrl: string
  selfOpenId?: string
  chatId?: string
  pollIntervalSeconds?: number
  codexTarget?: { name: string; cwd: string; command: string; args: string[]; statePath: string }
}): Promise<Daemon> {
  const dataDir = mkdtempSync(join(tmpdir(), 'lark-daemon-test-'))
  const mockDir = join(dataDir, 'mock')
  mkdirSync(mockDir, { recursive: true })
  const port = await getFreePort()
  const selfOpenId = opts.selfOpenId ?? 'ou_test_self'
  const chatId = opts.chatId ?? 'oc_test'
  const fakeCli = join(PKG_DIR, 'tests', 'fake-lark-cli.sh')
  try { chmodSync(fakeCli, 0o755) } catch {}

  // Two-bucket data, same as prod: config.yaml (non-secret) + secrets.yaml
  // (self_open_id + group webhooks) in the config dir the daemon resolves via
  // KA_CONFIG_DIR. state.json/log/pid stay in KA_DAEMON_DATA_DIR; both = dataDir.
  const codexLines = opts.codexTarget
    ? `    codex:\n      targets:\n        - name: ${opts.codexTarget.name}\n          cwd: ${opts.codexTarget.cwd}\n          group: Test Group\n`
    : ''
  writeFileSync(join(dataDir, 'config.yaml'),
    `channels:\n  lark:\n    port: ${port}\n` +
    `    poll_interval_seconds: ${opts.pollIntervalSeconds ?? 1}\n` +
    `    page_size: 20\n    lark_cli_bin: "${fakeCli}"\n${codexLines}`)
  writeFileSync(join(dataDir, 'secrets.yaml'),
    `channels:\n  lark:\n    self_open_id: "${selfOpenId}"\n    groups:\n` +
    `      ${chatId}:\n        name: "Test Group"\n        webhook_url: "${opts.webhookUrl}"\n`)

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    KA_DAEMON_DATA_DIR: dataDir,
    KA_CONFIG_DIR: dataDir,
    KA_PLATFORM_MODULE: join(PKG_DIR, 'lark-platform.ts'),
    LARK_MOCK_DIR: mockDir,
  }
  if (opts.codexTarget) {
    env.KA_CODEX_APP_SERVER_COMMAND = opts.codexTarget.command
    env.KA_CODEX_APP_SERVER_ARGS_JSON = JSON.stringify(opts.codexTarget.args)
    env.FAKE_CODEX_STATE = opts.codexTarget.statePath
  }
  const bundle = process.env.KA_TEST_DAEMON_BUNDLE
  const cmd = bundle
    ? ['node', bundle]
    : ['node', '--experimental-strip-types', join(PKG_DIR, '..', 'core', 'src', 'main.ts')]
  if (bundle) delete env.KA_PLATFORM_MODULE
  const proc = spawn(cmd[0], cmd.slice(1), { cwd: PKG_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  // proc.stderr?.on('data', d => process.stderr.write(`[lark-daemon] ${d}`))  // debug

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try { const r = await fetch(`${baseUrl}/api/status`); if (r.ok) break } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  return {
    port, dataDir, mockDir, proc, baseUrl,
    pushMessages: (chat: string, messages: any[]) => {
      // lark-cli shape: { ok, data: { messages: [...] } } (fetchChatMessages reads r.data.data.messages)
      writeFileSync(join(mockDir, `${chat}.json`), JSON.stringify({ ok: true, data: { messages } }))
    },
    stop: () => new Promise<void>(resolve => {
      const finish = () => { try { rmSync(dataDir, { recursive: true, force: true }) } catch {}; resolve() }
      if (proc.exitCode !== null || proc.signalCode !== null) return finish()
      const fallback = setTimeout(() => proc.kill('SIGKILL'), 6_000)
      proc.once('exit', () => { clearTimeout(fallback); finish() })
      proc.kill('SIGTERM')
    }),
  }
}

// ── MCP client ──────────────────────────────────────────────────────────────
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface ChannelClient {
  client: Client
  received: Array<{ content: string; meta: Record<string, string> }>
  close(): Promise<void>
}

export async function connectClient(baseUrl: string, name: string): Promise<ChannelClient> {
  const received: Array<{ content: string; meta: Record<string, string> }> = []
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp?name=${name}`))
  const client = new Client({ name: `test-${name}`, version: '0.0.0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async (n: any) => {
    if (n?.method === 'notifications/claude/channel') received.push({ content: n.params?.content, meta: n.params?.meta })
  }
  await client.connect(transport)
  return { client, received, close: async () => { try { await client.close() } catch {} } }
}

/** A canned lark message from the owner (self), minute-precision create_time. */
export function ownerMsg(opts: { mid: string; text: string; createTime: string; selfOpenId?: string }): any {
  return {
    message_id: opts.mid,
    create_time: opts.createTime,
    sender: { id: opts.selfOpenId ?? 'ou_test_self', sender_type: 'user', name: 'Owner' },
    content: opts.text,
  }
}

export async function waitFor(pred: () => boolean, ms = 5000, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, step))
  }
  return pred()
}
