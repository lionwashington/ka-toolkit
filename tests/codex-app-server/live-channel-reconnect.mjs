import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BindingStore } from '../../channels/core/src/bindings.ts'
import { AppServerClient } from '../../channels/core/src/codex/app-server-client.ts'
import { CodexChannelTarget } from '../../channels/core/src/codex/channel-target.ts'

if (process.env.KA_LIVE_CODEX_E2E !== '1') {
  console.log('SKIP: set KA_LIVE_CODEX_E2E=1 to run the live reconnect test')
  process.exit(0)
}

const port = 45_000 + Math.floor(Math.random() * 10_000)
const endpoint = `ws://127.0.0.1:${port}`
const child = spawn('codex', [
  '--dangerously-bypass-approvals-and-sandbox',
  'app-server', '--listen', endpoint,
], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr += chunk })

const deadline = Date.now() + 15_000
while (Date.now() < deadline) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 100))
}

const dir = mkdtempSync(join(tmpdir(), 'ka-live-reconnect-'))
const events = []
const client = new AppServerClient({ endpoint, requestTimeoutMs: 30_000 })
const reconnect = client.reconnect.bind(client)
let reconnectAfter = 0
client.reconnect = async () => {
  if (Date.now() < reconnectAfter) throw new Error('simulated transient App Server outage')
  await reconnect()
}
const target = new CodexChannelTarget({
  name: 'live-reconnect', platform: 'telegram', externalChatId: 'test', cwd: dir,
  client, bindings: new BindingStore(join(dir, 'bindings.json')),
  transportRecoveryTimeoutMs: 60_000,
  onEvent: event => { events.push(event) },
})

try {
  const delivered = target.deliver({
    content: 'Use a shell command to sleep for 8 seconds, then reply with exactly LIVE_RECONNECT_OK.',
    meta: {},
  })
  while (!events.some(event => event.type === 'turn-started')) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await new Promise(resolve => setTimeout(resolve, 500))
  reconnectAfter = Date.now() + 5_000
  client.websocket.close()
  await delivered
  const finals = events.filter(event => event.type === 'final')
  if (finals.length !== 1 || !finals[0].text.includes('LIVE_RECONNECT_OK')) {
    throw new Error(`unexpected recovered finals: ${JSON.stringify(finals)}`)
  }
  console.log('PASS: active Codex turn survived a five-second App Server WebSocket outage')
} finally {
  target.shutdown()
  await client.stop().catch(() => {})
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
  if (child.exitCode && child.exitCode !== 143) process.stderr.write(stderr)
}
