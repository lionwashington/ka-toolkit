import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServerClient } from './client.mjs'

const fake = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))

function makeClient(statePath, extra = {}) {
  return new AppServerClient({
    command: process.execPath,
    args: [fake],
    env: { ...process.env, FAKE_CODEX_STATE: statePath },
    requestTimeoutMs: 500,
    ...extra,
  })
}

function waitForNotification(client, method) {
  return new Promise(resolve => {
    const listener = message => {
      if (message.method !== method) return
      client.off('notification', listener)
      resolve(message.params)
    }
    client.on('notification', listener)
  })
}

test('initialize, start a durable thread, stream a turn, and resume after process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-fake-'))
  const statePath = join(dir, 'state.json')
  const first = makeClient(statePath)
  await first.start()
  const init = await first.initialize()
  assert.equal(init.platformOs, 'test')

  const startedNotice = waitForNotification(first, 'thread/started')
  const started = await first.request('thread/start', { cwd: dir, ephemeral: false })
  assert.equal(started.thread.ephemeral, false)
  assert.match(started.thread.path, /\.jsonl$/)
  assert.equal((await startedNotice).thread.id, started.thread.id)

  const delta = waitForNotification(first, 'item/agentMessage/delta')
  const completed = waitForNotification(first, 'turn/completed')
  await first.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'hello' }] })
  assert.equal((await delta).delta, 'echo:hello')
  assert.equal((await completed).turn.status, 'completed')
  await first.stop()

  const second = makeClient(statePath)
  await second.start()
  await second.initialize()
  const resumed = await second.request('thread/resume', { threadId: started.thread.id })
  assert.equal(resumed.thread.id, started.thread.id)
  await second.stop()
})

test('answers server-initiated approval requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-approval-'))
  const client = makeClient(join(dir, 'state.json'), {
    serverRequestHandler: async request => {
      assert.equal(request.method, 'item/commandExecution/requestApproval')
      return { decision: 'accept' }
    },
  })
  await client.start()
  await client.initialize()
  const started = await client.request('thread/start', { cwd: dir, ephemeral: true })
  const observed = waitForNotification(client, 'approval/observed')
  const completed = waitForNotification(client, 'turn/completed')
  await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'approve-me' }] })
  assert.equal((await observed).decision, 'accept')
  assert.equal((await completed).turn.status, 'completed')
  await client.stop()
})

test('times out a request and rejects pending work when the child exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-timeout-'))
  const client = makeClient(join(dir, 'state.json'))
  await client.start()
  await client.initialize()
  await assert.rejects(client.request('hang', {}, 30), /timed out/)
  const pending = client.request('hang', {}, 5_000)
  client.child.kill('SIGTERM')
  await assert.rejects(pending, /app-server exited/)
})

