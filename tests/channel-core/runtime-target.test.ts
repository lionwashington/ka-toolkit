import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatchTargets } from '../../channels/core/src/dispatch.ts'
import type { Platform } from '../../channels/core/src/platform.ts'
import {
  clearRuntimeTargetsForTest,
  registerRuntimeTarget,
  unregisterRuntimeTarget,
} from '../../channels/core/src/targets.ts'

const sent: Array<{ target: string; text: string }> = []
const platform: Platform = {
  name: 'test',
  resolveReplyTarget: value => value,
  isSelf: () => true,
  startInbound: () => {},
  send: async (target, text) => { sent.push({ target, text }); return null },
  fetchAttachment: async () => '',
  instructions: () => '',
  replyToolDescription: '',
}

afterEach(() => {
  sent.length = 0
  clearRuntimeTargetsForTest()
})

test('dispatches an inbound platform message through a registered runtime target', async () => {
  const received: any[] = []
  registerRuntimeTarget({
    name: 'codex-one',
    runtime: 'codex',
    deliver: async message => { received.push(message) },
  })

  await dispatchTargets(platform, ['codex-one'], 'hello', { chat_id: 42, message_id: 7 })

  assert.deepEqual(received, [{
    content: 'hello',
    meta: {
      chat_id: '42',
      message_id: '7',
      channel_name: 'codex-one',
      routed_target: 'codex-one',
    },
  }])
  assert.deepEqual(sent, [])
})

test('runtime target registration is unique and unregister is identity-safe', () => {
  const first = { name: 'main', runtime: 'codex', deliver: async () => {} }
  const stale = { name: 'main', runtime: 'codex', deliver: async () => {} }
  registerRuntimeTarget(first)
  assert.throws(() => registerRuntimeTarget(stale), /already registered/)
  unregisterRuntimeTarget('main', stale)
  assert.throws(() => registerRuntimeTarget(stale), /already registered/)
  unregisterRuntimeTarget('main', first)
  assert.doesNotThrow(() => registerRuntimeTarget(stale))
})

test('reports a route miss only after checking runtime targets', async () => {
  await dispatchTargets(platform, ['missing'], 'hello', { chat_id: 'owner' })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /not found: missing/)
})
