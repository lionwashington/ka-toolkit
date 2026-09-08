import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRuntimeManager } from '../../channels/core/src/codex/runtime-manager.ts'
import { retryTelegramEdit, canRetryTelegramSend } from '../../channels/telegram/retry-edit.ts'
import { startFakeSocketServer } from '../codex-app-server/fake-socket-server.mjs'
import { fileURLToPath } from 'node:url'
import { dispatchTargets } from '../../channels/core/src/dispatch.ts'

test('edit retries are bounded, idempotent, and never expose error credentials', async () => {
  assert.equal(canRetryTelegramSend({ error_code: 429, parameters: { retry_after: 1 } }), true)
  for (const error of [{ error_code: 500 }, { name: 'HttpError' }, Error('ECONNRESET'), { error_code: 403 }, { error_code: 429, parameters: { retry_after: 60 } }]) {
    assert.equal(canRetryTelegramSend(error), false)
  }
  let calls = 0
  const delays: number[] = []
  assert.equal(await retryTelegramEdit(async () => { if (++calls < 3) throw Error('Network request failed') }, async ms => { delays.push(ms) }), null)
  assert.equal(calls, 3)
  assert.deepEqual(delays, [250, 500])
  calls = 0
  assert.equal(await retryTelegramEdit(async () => { calls++; throw { error_code: 403, message: 'secret-url' } }), 'Telegram message edit failed')
  assert.equal(calls, 1)
  assert.equal(await retryTelegramEdit(async () => { throw Error('message is not modified') }), null)
  calls = 0
  await retryTelegramEdit(async () => { calls++; throw { error_code: 429, parameters: { retry_after: 60 } } })
  assert.equal(calls, 1)
})

for (const mode of ['start', 'update', 'finish', 'send'] as const) {
  test(`isolated App Server turn survives ${mode} delivery failure without duplicate send or model error`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ka-delivery-test-'))
    let sends = 0, finishes = 0
    const unhandled: unknown[] = []
    const listener = (e: unknown) => { unhandled.push(e) }
    process.on('unhandledRejection', listener)
    const platform: any = {
      name: 'telegram', resolveReplyTarget: (s: string) => s, isSelf: () => true,
      startInbound() {}, fetchAttachment: async () => '', instructions: () => '', replyToolDescription: '',
      send: async () => { sends++; if (mode === 'send') throw Error('synthetic transport'); return null },
      startStream: mode === 'send' ? undefined : async () => { if (mode === 'start') throw Error('synthetic transport'); return {} },
      updateStream: async () => { if (mode === 'update') throw Error('synthetic transport'); return null },
      finishStream: async () => { finishes++; if (mode === 'finish') return 'synthetic transport'; return null },
    }
    const manager = new CodexRuntimeManager(platform, { platform: 'telegram', bindingsPath: join(dir, 'bindings.json'), externalChatId: 'owner', requestTimeoutMs: 1000 })
    const server = await startFakeSocketServer({ socketPath: join(dir, 'server.sock'), fakePath: fileURLToPath(new URL('../codex-app-server/fake-app-server.mjs', import.meta.url)), statePath: join(dir, 'fake.json') })
    try {
      await manager.register({ name: 'delivery-test', cwd: dir, socketPath: join(dir, 'server.sock') })
      await dispatchTargets(platform, ['delivery-test'], 'synthetic hello', { chat_id: 'owner' })
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.deepEqual(unhandled, [])
      assert.equal(sends, mode === 'send' ? 1 : 0)
      assert.equal(finishes, mode === 'send' || mode === 'start' ? 0 : 1)
      if (mode !== 'update') {
        const files = readdirSync(join(dir, 'undelivered'))
        assert.equal(files.length, 1)
        const file = join(dir, 'undelivered', files[0])
        const record = JSON.parse(readFileSync(file, 'utf8'))
        assert.match(record.text, /synthetic hello/)
        assert.equal(record.automatic_replay, false)
        assert.equal(statSync(file).mode & 0o777, 0o600)
        assert.ok(!JSON.stringify(record).includes('synthetic transport'))
      }
    } finally {
      await manager.stop(); await server.close(); process.off('unhandledRejection', listener)
    }
  })
}

test('a rejected Lark preview is observed and does not block finalization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-preview-rejection-'))
  let updates = 0, finals = 0
  const platform: any = {
    name: 'lark', resolveReplyTarget: (s: string) => s,
    startStream: async () => ({}),
    updateStream: async () => { updates++; throw Error('synthetic preview rejection') },
    finishStream: async () => { finals++; return null },
  }
  const manager = new CodexRuntimeManager(platform, { platform: 'lark', bindingsPath: join(dir, 'bindings.json'), externalChatId: 'owner' })
  const emit = (manager as any).onEvent.bind(manager)
  try {
    await emit('test', { type: 'turn-started', turnId: 'turn' }, 'owner')
    await emit('test', { type: 'text-delta', turnId: 'turn', delta: 'draft' }, 'owner')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(updates, 1)
    await emit('test', { type: 'final', turnId: 'turn', text: 'complete' }, 'owner')
    assert.equal(finals, 1)
    assert.equal((manager as any).streams.size, 0)
  } finally { await manager.stop() }
})
