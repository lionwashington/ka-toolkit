import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerClient } from './client.mjs'

if (process.env.KA_LIVE_CODEX_E2E !== '1') {
  console.error('refusing live Codex call: set KA_LIVE_CODEX_E2E=1 explicitly')
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'ka-codex-persist-'))
const codexHome = join(root, 'codex-home')
const cwd = join(root, 'workspace')
mkdirSync(codexHome, { mode: 0o700 })
mkdirSync(cwd)

const sourceAuth = join(homedir(), '.codex', 'auth.json')
if (!existsSync(sourceAuth)) throw new Error(`Codex auth file not found: ${sourceAuth}`)
copyFileSync(sourceAuth, join(codexHome, 'auth.json'))
chmodSync(join(codexHome, 'auth.json'), 0o600)

const env = { ...process.env, CODEX_HOME: codexHome }
let first
let second

function completion(client, threadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn/completed timeout')), 120_000)
    const listener = message => {
      if (message.method !== 'turn/completed' || message.params.threadId !== threadId) return
      clearTimeout(timer)
      client.off('notification', listener)
      if (message.params.turn.status === 'completed') resolve(message.params.turn)
      else reject(new Error(`turn ended with ${message.params.turn.status}`))
    }
    client.on('notification', listener)
  })
}

try {
  first = new AppServerClient({ env, requestTimeoutMs: 120_000 })
  await first.start()
  await first.initialize()
  const started = await first.request('thread/start', {
    cwd,
    ephemeral: false,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
  if (started.thread.ephemeral) throw new Error('expected a durable thread')
  if (!started.thread.path) throw new Error('durable thread has no rollout path')
  const firstDone = completion(first, started.thread.id)
  await first.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'Remember the marker KA_PERSIST_719. Reply exactly: STORED' }],
  })
  await firstDone
  await first.stop()
  first = null
  if (!existsSync(started.thread.path)) throw new Error(`rollout was not written: ${started.thread.path}`)

  second = new AppServerClient({ env, requestTimeoutMs: 120_000 })
  await second.start()
  await second.initialize()
  const resumed = await second.request('thread/resume', { threadId: started.thread.id })
  if (resumed.thread.id !== started.thread.id) throw new Error('resume returned a different thread')
  let answer = ''
  second.on('notification', message => {
    if (message.method === 'item/agentMessage/delta') answer += message.params.delta
  })
  const secondDone = completion(second, started.thread.id)
  await second.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'What marker did I ask you to remember? Reply with the marker only.' }],
  })
  await secondDone
  if (answer.trim() !== 'KA_PERSIST_719') throw new Error(`unexpected resumed answer: ${answer}`)
  console.log(`persistent resume OK: ${started.thread.id}`)
} finally {
  await first?.stop()
  await second?.stop()
  rmSync(root, { recursive: true, force: true })
}

