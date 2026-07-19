import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerClient } from './client.mjs'

if (process.env.KA_LIVE_CODEX_E2E !== '1') {
  console.error('refusing live Codex call: set KA_LIVE_CODEX_E2E=1 explicitly')
  process.exit(2)
}

const cwd = mkdtempSync(join(tmpdir(), 'ka-codex-live-'))
const client = new AppServerClient({ requestTimeoutMs: 120_000 })
client.on('notification', message => process.stdout.write(`${JSON.stringify(message)}\n`))
client.on('protocol-error', error => console.error(error))

try {
  await client.start()
  const initialized = await client.initialize()
  console.error(`initialized: ${initialized.userAgent}`)
  const started = await client.request('thread/start', {
    cwd,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
  console.error(`thread: ${started.thread.id}`)
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn/completed timeout')), 120_000)
    client.on('notification', message => {
      if (message.method !== 'turn/completed' || message.params.threadId !== started.thread.id) return
      clearTimeout(timer)
      resolve(message.params.turn)
    })
  })
  await client.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'Reply with exactly: KA_CODEX_APP_SERVER_OK' }],
  })
  const turn = await completed
  if (turn.status !== 'completed') throw new Error(`turn ended with ${turn.status}`)
} finally {
  await client.stop()
}

