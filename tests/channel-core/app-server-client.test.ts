import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServerClient } from '../../channels/core/src/codex/app-server-client.ts'

const fake = fileURLToPath(new URL('../codex-app-server/fake-app-server.mjs', import.meta.url))

function makeClient(statePath: string, extra: Record<string, unknown> = {}): AppServerClient {
  return new AppServerClient({
    command: process.execPath,
    args: [fake],
    env: { ...process.env, FAKE_CODEX_STATE: statePath },
    requestTimeoutMs: 500,
    ...extra,
  })
}

function waitForNotification(client: AppServerClient, method: string): Promise<any> {
  return new Promise(resolve => {
    const listener = (message: any) => {
      if (message.method !== method) return
      client.off('notification', listener)
      resolve(message.params)
    }
    client.on('notification', listener)
  })
}

test('production client initializes, runs a turn, and resumes a durable thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-channel-codex-'))
  const statePath = join(dir, 'state.json')
  const first = makeClient(statePath)
  await first.start()
  await first.initialize()
  const started = await first.request('thread/start', { cwd: dir, ephemeral: false })
  const completed = waitForNotification(first, 'turn/completed')
  await first.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'hello' }] })
  assert.equal((await completed).turn.status, 'completed')
  await first.stop()

  const second = makeClient(statePath)
  await second.start()
  await second.initialize()
  const resumed = await second.request('thread/resume', { threadId: started.thread.id })
  assert.equal(resumed.thread.id, started.thread.id)
  await second.stop()
})

test('production client answers approval requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-channel-approval-'))
  const client = makeClient(join(dir, 'state.json'), {
    serverRequestHandler: async (request: any) => {
      assert.equal(request.method, 'item/commandExecution/requestApproval')
      return { decision: 'accept' }
    },
  })
  await client.start()
  await client.initialize()
  const started = await client.request('thread/start', { cwd: dir, ephemeral: true })
  const observed = waitForNotification(client, 'approval/observed')
  await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'approve-me' }] })
  assert.equal((await observed).decision, 'accept')
  await client.stop()
})

test('production client recovers after malformed server output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-channel-malformed-'))
  const client = makeClient(join(dir, 'state.json'))
  await client.start()
  await client.initialize()
  const protocolError = new Promise<Error>(resolve => client.once('protocol-error', resolve))
  const stillAlive = waitForNotification(client, 'test/still-alive')
  await client.request('test/emit-malformed', {})
  assert.match((await protocolError).message, /invalid app-server JSON/)
  assert.deepEqual(await stillAlive, { ok: true })
  await client.stop()
})
