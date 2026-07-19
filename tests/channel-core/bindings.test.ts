import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BindingStore, type ChannelBinding } from '../../channels/core/src/bindings.ts'

function fixture(): ChannelBinding {
  return {
    channelName: 'main',
    platform: 'telegram',
    externalChatId: 'chat-1',
    runtime: 'codex',
    runtimeSessionId: 'thread-1',
    cwd: '/workspace',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  }
}

test('persists and reloads a binding without transcript data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-bindings-'))
  const path = join(dir, 'bindings.json')
  new BindingStore(path).put(fixture())
  assert.deepEqual(new BindingStore(path).list(), [fixture()])
  assert.deepEqual(readdirSync(dir), ['bindings.json'])
})

test('keys platform threads independently and removes only the selected binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-bindings-'))
  const store = new BindingStore(join(dir, 'bindings.json'))
  const first = fixture()
  const second = { ...fixture(), externalThreadId: 'topic-2', runtimeSessionId: 'thread-2' }
  store.put(first)
  store.put(second)
  assert.equal(store.list().length, 2)
  assert.equal(store.remove(second), true)
  assert.equal(store.find(first)?.runtimeSessionId, 'thread-1')
})

test('fails closed for an unsupported binding schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-bindings-'))
  const path = join(dir, 'bindings.json')
  writeFileSync(path, JSON.stringify({ version: 99, bindings: {} }))
  assert.throws(() => new BindingStore(path), /unsupported channel binding file/)
})
