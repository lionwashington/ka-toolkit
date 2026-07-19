import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexRuntimeManager } from '../../channels/core/src/codex/runtime-manager.ts'
import { dispatchTargets } from '../../channels/core/src/dispatch.ts'
import { runtimeTargetOf } from '../../channels/core/src/targets.ts'
import type { Platform } from '../../channels/core/src/platform.ts'

const fake = fileURLToPath(new URL('../codex-app-server/fake-app-server.mjs', import.meta.url))

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('routes platform input through Codex and sends the final reply back through the platform', async () => {
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
    targets: [{ name: 'codex-main', cwd: dir, externalChatId: 'owner' }],
    client: {
      command: process.execPath,
      args: [fake],
      env: { ...process.env, FAKE_CODEX_STATE: join(dir, 'fake-state.json') },
      requestTimeoutMs: 500,
    },
  })
  await manager.start()
  assert.ok(runtimeTargetOf('codex-main'))
  await dispatchTargets(platform, ['codex-main'], 'hello', { chat_id: 'owner' })
  await waitFor(() => sent.some(message => message.text.includes('echo:hello')))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].target, 'owner')
  assert.match(sent[0].text, /echo:hello/)
  await manager.stop()
  assert.equal(runtimeTargetOf('codex-main'), undefined)
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
    targets: [{ name: 'codex-main', cwd: dir, externalChatId: 'owner' }],
    client: {
      command: process.execPath,
      args: [fake],
      env: { ...process.env, FAKE_CODEX_STATE: join(dir, 'fake-state.json') },
      requestTimeoutMs: 500,
    },
  })
  await manager.start()
  await dispatchTargets(platform, ['codex-main'], 'approve-me', { chat_id: 'owner' })
  while (!sent.some(message => message.text.includes('requests approval 10000'))) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await dispatchTargets(platform, ['codex-main'], '/approve 10000', { chat_id: 'owner' })
  await waitFor(() => sent.some(message => message.text.includes('echo:approve-me')))
  assert.ok(sent.some(message => message.text.includes('Approval 10000 accepted.')))
  assert.ok(sent.some(message => message.text.includes('echo:approve-me')))
  const before = sent.length
  await dispatchTargets(platform, ['codex-main'], '/approve 10000', { chat_id: 'owner' })
  await waitFor(() => sent.length === before + 1)
  assert.equal(sent.length, before + 1)
  assert.match(sent.at(-1)!.text, /not pending/)
  await manager.stop()
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
    targets: [{ name: 'codex-stop', cwd: dir, externalChatId: 'owner' }],
    client: {
      command: process.execPath,
      args: [fake],
      env: { ...process.env, FAKE_CODEX_STATE: join(dir, 'fake-state.json') },
      requestTimeoutMs: 500,
    },
  })
  await manager.start()
  await dispatchTargets(platform, ['codex-stop'], 'approve-me', { chat_id: 'owner' })
  await waitFor(() => sent.some(message => message.includes('requests approval')))
  await manager.stop()
  assert.equal(runtimeTargetOf('codex-stop'), undefined)
})
