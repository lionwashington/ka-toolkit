import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRuntimeManager } from '../../channels/core/src/codex/runtime-manager.ts'
import { createHttpApp } from '../../channels/core/src/http.ts'
import { runtimeTargetOf } from '../../channels/core/src/targets.ts'
import type { Platform } from '../../channels/core/src/platform.ts'

const platform: Platform = {
  name: 'telegram', resolveReplyTarget: value => value, isSelf: () => true,
  startInbound: () => {}, send: async () => null, fetchAttachment: async () => '',
  instructions: () => '', replyToolDescription: '',
}
async function waitFor(check: () => boolean) {
  const until = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < until, 'condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// Actual JSON-RPC sockets and HTTP, but no model, account, production port or
// production files. Hold resume responses to reproduce slow rollout recovery.
async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'ka-registration-race-'))
  const sockets = new Set<Socket>()
  const resumes: Array<{ finish: (fail?: boolean) => void }> = []
  const socketPath = join(dir, 'rpc.sock')
  const rpc = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    createInterface({ input: socket }).on('line', line => {
      const message = JSON.parse(line)
      const send = (result: unknown) => socket.write(JSON.stringify({ id: message.id, result }) + '\n')
      if (message.method === 'initialize') send({ userAgent: 'synthetic' })
      if (message.method === 'thread/resume') resumes.push({ finish: (fail = false) => {
        if (fail) socket.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'synthetic resume failure' } }) + '\n')
        else send({ thread: { id: message.params.threadId, cwd: dir, status: { type: 'idle' }, turns: [] }, model: 'synthetic' })
      } })
    })
  })
  await new Promise<void>(resolve => rpc.listen(socketPath, resolve))
  const manager = new CodexRuntimeManager(platform, {
    platform: 'telegram', bindingsPath: join(dir, 'bindings.json'), externalChatId: 'synthetic', requestTimeoutMs: 1000,
  })
  t.after(async () => {
    await manager.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => rpc.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })
  const registration = { name: 'synthetic-mate', cwd: dir, socketPath, threadId: 'synthetic-thread' }
  return { dir, manager, resumes, registration, sockets }
}

test('concurrent slow registration retries perform exactly one resume, including metadata changes', async t => {
  const { manager, registration, resumes, sockets } = await fixture(t)
  const calls = Array.from({ length: 20 }, (_, i) => manager.register({ ...registration, threadPath: `/synthetic/${i}` }))
  await waitFor(() => resumes.length > 0)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(resumes.length, 1)
  resumes[0].finish()
  await Promise.all(calls)
  assert.equal(resumes.length, 1)
  assert.equal(sockets.size, 1)
  const target = runtimeTargetOf(registration.name)
  await manager.register(registration)
  assert.equal(runtimeTargetOf(registration.name), target)
})

test('failed registration does not poison a queued retry', async t => {
  const { manager, registration, resumes } = await fixture(t)
  const first = assert.rejects(manager.register(registration), /synthetic resume failure/)
  const second = manager.register(registration)
  await waitFor(() => resumes.length === 1)
  resumes[0].finish(true)
  await first
  await waitFor(() => resumes.length === 2)
  resumes[1].finish()
  await second
  assert.ok(runtimeTargetOf(registration.name)?.isAlive())
})

test('different mates register independently while same-mate instance changes are ordered', async t => {
  const { manager, registration, resumes } = await fixture(t)
  const first = manager.register(registration)
  await waitFor(() => resumes.length === 1)
  const other = manager.register({ ...registration, name: 'synthetic-other' })
  await waitFor(() => resumes.length === 2)
  resumes[1].finish()
  await other
  const replacement = manager.register({ ...registration, threadId: 'synthetic-next' })
  assert.equal(resumes.length, 2)
  resumes[0].finish()
  await first
  const original = runtimeTargetOf(registration.name)
  await waitFor(() => resumes.length === 3)
  resumes[2].finish()
  await replacement
  assert.notEqual(runtimeTargetOf(registration.name), original)
})

for (const operation of ['unregister', 'stop'] as const) {
  test(`${operation} cancels an in-flight resume and queued retries without late resurrection`, async t => {
    const { manager, registration, resumes } = await fixture(t)
    const first = assert.rejects(manager.register(registration), /closed|cancelled/)
    await waitFor(() => resumes.length === 1)
    const queued = assert.rejects(manager.register(registration), /cancelled/)
    if (operation === 'stop') await manager.stop()
    else await manager.unregister(registration.name)
    await Promise.all([first, queued])
    assert.equal(runtimeTargetOf(registration.name), undefined)
    assert.equal(resumes.length, 1)
    if (operation === 'stop') await assert.rejects(manager.register(registration), /stopped/)
    else {
      const retry = manager.register(registration)
      await waitFor(() => resumes.length === 2)
      resumes[1].finish()
      await retry
      assert.ok(runtimeTargetOf(registration.name))
    }
  })
}

test('stop before a queued registration starts creates no connection', async t => {
  const { manager, registration, resumes, sockets } = await fixture(t)
  const pending = assert.rejects(manager.register(registration), /cancelled/)
  await manager.stop()
  await pending
  assert.equal(resumes.length, 0)
  assert.equal(sockets.size, 0)
})

test('concurrent fresh-thread promotions resume once and remain cancellable', async t => {
  const { manager, registration, resumes } = await fixture(t)
  await manager.register({ ...registration, allowUnpersistedThread: true })
  const original = runtimeTargetOf(registration.name)
  const promotions = Array.from({ length: 5 }, () => manager.register({ ...registration, allowUnpersistedThread: false }))
  await waitFor(() => resumes.length === 1)
  resumes[0].finish()
  await Promise.all(promotions)
  assert.equal(resumes.length, 1)
  assert.equal(runtimeTargetOf(registration.name), original)

  await manager.unregister(registration.name)
  await manager.register({ ...registration, allowUnpersistedThread: true })
  const promotion = assert.rejects(manager.register({ ...registration, allowUnpersistedThread: false }), /closed|cancelled/)
  await waitFor(() => resumes.length === 2)
  await manager.unregister(registration.name)
  await promotion
  assert.equal(runtimeTargetOf(registration.name), undefined)
})

test('isolated HTTP E2E: abandoned caller plus retries retain one background resume', async t => {
  const { manager, registration, resumes } = await fixture(t)
  const server = createHttpApp(platform, manager).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  const controller = new AbortController()
  const post = (signal?: AbortSignal) => fetch(`${base}/api/runtimes/codex`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ name: registration.name, cwd: registration.cwd,
      socket_path: registration.socketPath, thread_id: registration.threadId }),
  })
  const abandoned = assert.rejects(post(controller.signal), /abort/i)
  await waitFor(() => resumes.length === 1)
  controller.abort()
  await abandoned
  const retries = Array.from({ length: 12 }, () => post())
  // Observe failures even if an assertion fails before responses are released.
  for (const retry of retries) void retry.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(resumes.length, 1)
  resumes[0].finish()
  for (const response of await Promise.all(retries)) {
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
  }
  assert.equal(resumes.length, 1)
  const status = await (await fetch(`${base}/api/status`)).json()
  assert.equal(status.runtime_targets.filter((x: any) => x.name === registration.name).length, 1)
})
