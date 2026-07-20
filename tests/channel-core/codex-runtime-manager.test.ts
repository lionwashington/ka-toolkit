import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexRuntimeManager, describeApproval } from '../../channels/core/src/codex/runtime-manager.ts'
import { dispatchTargets } from '../../channels/core/src/dispatch.ts'
import { runtimeTargetOf } from '../../channels/core/src/targets.ts'
import type { Platform } from '../../channels/core/src/platform.ts'
import { startFakeSocketServer } from '../codex-app-server/fake-socket-server.mjs'
import { counters } from '../../channels/core/src/counters.ts'

const fake = fileURLToPath(new URL('../codex-app-server/fake-app-server.mjs', import.meta.url))

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('describes approval actions without exposing the JSON-RPC request id', () => {
  assert.equal(describeApproval({ id: 0, method: 'item/commandExecution/requestApproval', params: { command: 'pnpm test' } }), 'pnpm test')
  assert.equal(describeApproval({ id: 0, method: 'item/fileChange/requestApproval', params: { grantRoot: '/tmp/work' } }), 'write access: /tmp/work')
  assert.equal(describeApproval({ id: 0, method: 'item/permissions/requestApproval', params: { permissions: { network: true } } }), 'permissions: {"network":true}')
})

test('routes platform input through Codex and sends the final reply back through the platform', async () => {
  const repliesBefore = counters.replies
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-manager-'))
  const sent: Array<{ target: string; text: string }> = []
  const platform: Platform = {
    name: 'telegram',
    resolveReplyTarget: value => value === 'owner' ? value : null,
    isSelf: () => true,
    startInbound: () => {},
    send: async (target, text) => { sent.push({ target, text }); return null },
    fetchAttachment: async () => '',
    instructions: () => '',
    replyToolDescription: '',
  }
  const manager = new CodexRuntimeManager(platform, {
    platform: 'telegram',
    bindingsPath: join(dir, 'bindings.json'),
    externalChatId: 'owner',
    requestTimeoutMs: 500,
  })
  const socketPath = join(dir, 'app-server.sock')
  const appServer = await startFakeSocketServer({ socketPath, fakePath: fake, statePath: join(dir, 'fake-state.json') })
  await manager.register({ name: 'codex-main', cwd: dir, socketPath })
  assert.ok(runtimeTargetOf('codex-main'))
  await dispatchTargets(platform, ['codex-main'], 'hello', { chat_id: 'owner' })
  await waitFor(() => sent.some(message => message.text.includes('echo:hello')))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].target, 'owner')
  assert.match(sent[0].text, /echo:hello/)
  assert.equal(counters.replies, repliesBefore + 1)
  await manager.stop()
  await appServer.close()
  assert.equal(runtimeTargetOf('codex-main'), undefined)
})

test('keeps a runtime connection when a registrar retry only changes thread metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-register-idempotent-'))
  const platform: Platform = {
    name: 'telegram',
    resolveReplyTarget: value => value,
    isSelf: () => true,
    startInbound: () => {},
    send: async () => null,
    fetchAttachment: async () => '',
    instructions: () => '',
    replyToolDescription: '',
  }
  const manager = new CodexRuntimeManager(platform, {
    platform: 'telegram',
    bindingsPath: join(dir, 'bindings.json'),
    externalChatId: 'owner',
    requestTimeoutMs: 500,
  })
  const socketPath = join(dir, 'app-server.sock')
  const appServer = await startFakeSocketServer({ socketPath, fakePath: fake, statePath: join(dir, 'fake-state.json') })
  await manager.register({ name: 'codex-main', cwd: dir, socketPath })
  const original = runtimeTargetOf('codex-main')

  await manager.register({
    name: 'codex-main',
    cwd: dir,
    socketPath,
    threadPath: join(dir, 'thread-1.jsonl'),
  })

  assert.equal(runtimeTargetOf('codex-main'), original)
  assert.equal(original?.isAlive(), true)
  await manager.stop()
  await appServer.close()
})

test('binds an approval to its target and accepts a single-use owner command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-approval-manager-'))
  const sent: Array<{ target: string; text: string }> = []
  const platform: Platform = {
    name: 'telegram',
    resolveReplyTarget: value => value === 'owner' ? value : null,
    isSelf: () => true,
    startInbound: () => {},
    send: async (target, text) => { sent.push({ target, text }); return null },
    fetchAttachment: async () => '',
    instructions: () => '',
    replyToolDescription: '',
  }
  const manager = new CodexRuntimeManager(platform, {
    platform: 'telegram',
    bindingsPath: join(dir, 'bindings.json'),
    externalChatId: 'owner',
    requestTimeoutMs: 500,
  })
  const socketPath = join(dir, 'app-server.sock')
  const appServer = await startFakeSocketServer({ socketPath, fakePath: fake, statePath: join(dir, 'fake-state.json') })
  await manager.register({ name: 'codex-main', cwd: dir, socketPath })
  await dispatchTargets(platform, ['codex-main'], 'approve-me', { chat_id: 'owner' })
  while (!sent.some(message => message.text.includes('requests approval 1'))) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await dispatchTargets(platform, ['codex-main'], '/approve 1', { chat_id: 'owner' })
  await waitFor(() => sent.some(message => message.text.includes('echo:approve-me')))
  assert.ok(sent.some(message => message.text.includes('Approval 1 accepted.')))
  assert.ok(sent.some(message => message.text.includes('echo:approve-me')))
  const before = sent.length
  await dispatchTargets(platform, ['codex-main'], '/approve 1', { chat_id: 'owner' })
  await waitFor(() => sent.length === before + 1)
  assert.equal(sent.length, before + 1)
  assert.match(sent.at(-1)!.text, /not pending/)
  await manager.stop()
  await appServer.close()
})

test('stop unregisters the target and declines a pending approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-stop-manager-'))
  const sent: string[] = []
  const platform: Platform = {
    name: 'telegram',
    resolveReplyTarget: value => value === 'owner' ? value : null,
    isSelf: () => true,
    startInbound: () => {},
    send: async (_target, text) => { sent.push(text); return null },
    fetchAttachment: async () => '',
    instructions: () => '',
    replyToolDescription: '',
  }
  const manager = new CodexRuntimeManager(platform, {
    platform: 'telegram',
    bindingsPath: join(dir, 'bindings.json'),
    externalChatId: 'owner',
    requestTimeoutMs: 500,
  })
  const socketPath = join(dir, 'app-server.sock')
  const appServer = await startFakeSocketServer({ socketPath, fakePath: fake, statePath: join(dir, 'fake-state.json') })
  await manager.register({ name: 'codex-stop', cwd: dir, socketPath })
  await dispatchTargets(platform, ['codex-stop'], 'approve-me', { chat_id: 'owner' })
  await waitFor(() => sent.some(message => message.includes('requests approval')))
  await manager.stop()
  await appServer.close()
  assert.equal(runtimeTargetOf('codex-stop'), undefined)
})

test('serializes the final stream edit after an in-flight incremental edit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-stream-manager-'))
  const calls: string[] = []
  let releaseUpdate!: () => void
  const updateBlocked = new Promise<void>(resolve => { releaseUpdate = resolve })
  const platform: Platform = {
    name: 'telegram',
    resolveReplyTarget: value => value,
    isSelf: () => true,
    startInbound: () => {},
    send: async () => null,
    startStream: async () => ({ messageId: 1 }),
    updateStream: async () => { calls.push('update:start'); await updateBlocked; calls.push('update:end'); return null },
    finishStream: async () => { calls.push('finish'); return null },
    fetchAttachment: async () => '',
    instructions: () => '',
    replyToolDescription: '',
  }
  const manager = new CodexRuntimeManager(platform, {
    platform: 'telegram',
    bindingsPath: join(dir, 'bindings.json'),
    externalChatId: 'owner',
  })
  const onEvent = (manager as any).onEvent.bind(manager)
  await onEvent('codex-main', { type: 'turn-started', threadId: 'thread-1', turnId: 'turn-1' }, 'owner')
  await onEvent('codex-main', { type: 'text-delta', threadId: 'thread-1', turnId: 'turn-1', delta: 'partial' }, 'owner')
  await waitFor(() => calls.includes('update:start'))
  const final = onEvent('codex-main', { type: 'final', threadId: 'thread-1', turnId: 'turn-1', text: 'complete' }, 'owner')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(calls, ['update:start'])
  releaseUpdate()
  await final
  assert.deepEqual(calls, ['update:start', 'update:end', 'finish'])
})
