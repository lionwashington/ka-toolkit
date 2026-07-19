import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerClient } from './client.mjs'

if (process.env.KA_LIVE_CODEX_E2E !== '1') {
  console.error('refusing live Codex call: set KA_LIVE_CODEX_E2E=1 explicitly')
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), 'ka-codex-concurrent-live-'))
const codexHome = join(root, 'codex-home')
const firstCwd = join(root, 'first')
const secondCwd = join(root, 'second')
mkdirSync(codexHome, { mode: 0o700 })
mkdirSync(firstCwd)
mkdirSync(secondCwd)

const sourceAuth = join(homedir(), '.codex', 'auth.json')
if (!existsSync(sourceAuth)) throw new Error(`Codex auth file not found: ${sourceAuth}`)
copyFileSync(sourceAuth, join(codexHome, 'auth.json'))
chmodSync(join(codexHome, 'auth.json'), 0o600)

const client = new AppServerClient({
  env: { ...process.env, CODEX_HOME: codexHome },
  requestTimeoutMs: 120_000,
})

function completion(threadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn/completed timeout: ${threadId}`)), 120_000)
    const listener = message => {
      if (message.method !== 'turn/completed' || message.params.threadId !== threadId) return
      clearTimeout(timer)
      client.off('notification', listener)
      resolve(message.params.turn)
    }
    client.on('notification', listener)
  })
}

function turnStarted(threadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn/started timeout: ${threadId}`)), 30_000)
    const listener = message => {
      if (message.method !== 'turn/started' || message.params.threadId !== threadId) return
      clearTimeout(timer)
      client.off('notification', listener)
      resolve(message.params.turn)
    }
    client.on('notification', listener)
  })
}

try {
  await client.start()
  await client.initialize()
  const [first, second] = await Promise.all([
    client.request('thread/start', { cwd: firstCwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' }),
    client.request('thread/start', { cwd: secondCwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' }),
  ])
  if (first.thread.id === second.thread.id) throw new Error('concurrent thread/start returned duplicate ids')

  let secondAnswer = ''
  client.on('notification', message => {
    if (message.method === 'item/agentMessage/delta' && message.params.threadId === second.thread.id) {
      secondAnswer += message.params.delta
    }
  })
  const firstDone = completion(first.thread.id)
  const secondDone = completion(second.thread.id)
  const firstActive = turnStarted(first.thread.id)
  const firstTurn = await client.request('turn/start', {
    threadId: first.thread.id,
    input: [{ type: 'text', text: 'Run the shell command `sleep 30`, then reply FIRST_DONE.' }],
  })
  await firstActive
  const secondTurnStarted = client.request('turn/start', {
    threadId: second.thread.id,
    input: [{ type: 'text', text: 'Reply with exactly: SECOND_OK' }],
  })
  await client.request('turn/interrupt', { threadId: first.thread.id, turnId: firstTurn.turn.id })
  await secondTurnStarted

  const [firstResult, secondResult] = await Promise.all([firstDone, secondDone])
  if (firstResult.status !== 'interrupted') throw new Error(`first turn ended with ${firstResult.status}`)
  if (secondResult.status !== 'completed') throw new Error(`second turn ended with ${secondResult.status}`)
  if (secondAnswer.trim() !== 'SECOND_OK') throw new Error(`unexpected second answer: ${secondAnswer}`)
  console.log(`concurrency + interrupt OK: ${first.thread.id}, ${second.thread.id}`)
} finally {
  await client.stop()
  rmSync(root, { recursive: true, force: true })
}
