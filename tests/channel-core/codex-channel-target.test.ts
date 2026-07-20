import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BindingStore } from '../../channels/core/src/bindings.ts'
import { AppServerClient } from '../../channels/core/src/codex/app-server-client.ts'
import { buildCodexTurnInput, CodexChannelTarget, type CodexChannelEvent } from '../../channels/core/src/codex/channel-target.ts'

const fake = fileURLToPath(new URL('../codex-app-server/fake-app-server.mjs', import.meta.url))

function client(statePath: string): AppServerClient {
  return new AppServerClient({
    command: process.execPath,
    args: [fake],
    env: { ...process.env, FAKE_CODEX_STATE: statePath },
    requestTimeoutMs: 500,
  })
}

function target(dir: string, appServer: AppServerClient, events: CodexChannelEvent[]): CodexChannelTarget {
  return new CodexChannelTarget({
    name: 'codex-main',
    platform: 'telegram',
    externalChatId: 'chat-1',
    cwd: dir,
    client: appServer,
    bindings: new BindingStore(join(dir, 'bindings.json')),
    onEvent: event => { events.push(event) },
  })
}

test('maps downloaded platform images to Codex localImage input', () => {
  assert.deepEqual(buildCodexTurnInput({
    content: 'describe this',
    meta: { attachment_path: '/tmp/photo.jpg', attachment_kind: 'photo' },
  }), [
    { type: 'text', text: 'describe this' },
    { type: 'localImage', path: '/tmp/photo.jpg' },
  ])
  assert.deepEqual(buildCodexTurnInput({
    content: '[attachment: notes.pdf]',
    meta: { attachment_path: '/tmp/notes.pdf', attachment_kind: 'document' },
  }), [{ type: 'text', text: '[attachment: notes.pdf]' }])
})

test('serializes turns, emits normalized events, and persists a durable binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-target-'))
  const events: CodexChannelEvent[] = []
  const appServer = client(join(dir, 'fake-state.json'))
  const runtime = target(dir, appServer, events)

  await Promise.all([
    runtime.deliver({ content: 'first', meta: { chat_id: 'chat-1' } }),
    runtime.deliver({ content: 'second', meta: { chat_id: 'chat-1' } }),
  ])

  assert.deepEqual(events.filter(event => event.type === 'final').map(event => event.text), ['echo:first', 'echo:second'])
  const stored = new BindingStore(join(dir, 'bindings.json')).list()[0]
  assert.match(stored.runtimeSessionId, /^thread-/)
  assert.equal(stored.activeTurnId, undefined)
  await appServer.stop()
})

test('resumes the persisted thread after the App Server process changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-resume-'))
  const statePath = join(dir, 'fake-state.json')
  const firstClient = client(statePath)
  await target(dir, firstClient, []).deliver({ content: 'first', meta: {} })
  await firstClient.stop()

  const secondClient = client(statePath)
  const events: CodexChannelEvent[] = []
  await target(dir, secondClient, events).deliver({ content: 'second', meta: {} })
  assert.deepEqual(events.filter(event => event.type === 'final').map(event => event.text), ['echo:second'])
  assert.equal(new BindingStore(join(dir, 'bindings.json')).list().length, 1)
  await secondClient.stop()
})

test('interrupts only the active turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-interrupt-'))
  const events: CodexChannelEvent[] = []
  const appServer = client(join(dir, 'fake-state.json'))
  const runtime = target(dir, appServer, events)
  const delivered = runtime.deliver({ content: 'wait-for-interrupt', meta: {} })
  while (!events.some(event => event.type === 'turn-started')) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(await runtime.interrupt(), true)
  await delivered
  assert.equal(events.find(event => event.type === 'turn-completed')?.status, 'interrupted')
  await appServer.stop()
})

test('/stop bypasses the FIFO and interrupts the active turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-stop-'))
  const events: CodexChannelEvent[] = []
  const appServer = client(join(dir, 'fake-state.json'))
  const runtime = target(dir, appServer, events)
  const active = runtime.deliver({ content: 'wait-for-interrupt', meta: {} })
  while (!events.some(event => event.type === 'turn-started')) await new Promise(resolve => setTimeout(resolve, 5))
  await runtime.deliver({ content: '/stop', meta: {} })
  await active
  assert.equal(events.find(event => event.type === 'activity')?.text, 'Interrupt requested.')
  assert.equal(events.find(event => event.type === 'turn-completed')?.status, 'interrupted')
  await appServer.stop()
})

test('fails an active turn promptly and resumes the binding on the next queued message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-recover-'))
  const events: CodexChannelEvent[] = []
  const appServer = client(join(dir, 'fake-state.json'))
  const runtime = target(dir, appServer, events)
  await assert.rejects(
    runtime.deliver({ content: 'crash-process', meta: {} }),
    /exited during an active turn/,
  )
  await runtime.deliver({ content: 'after-restart', meta: {} })
  assert.equal(events.find(event => event.type === 'final')?.text, 'echo:after-restart')
  await appServer.stop()
})

test('classifies a transport close separately and does not leak an unhandled rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-disconnect-'))
  const events: CodexChannelEvent[] = []
  const appServer = client(join(dir, 'fake-state.json'))
  const runtime = target(dir, appServer, events)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const delivered = runtime.deliver({ content: 'wait-for-interrupt', meta: {} })
    while (!events.some(event => event.type === 'turn-started')) await new Promise(resolve => setTimeout(resolve, 5))
    const error = new Error('simulated local WebSocket reset')
    ;(appServer as any).failAll(error)
    appServer.emit('transport-close', { transport: 'websocket', error })
    await assert.rejects(delivered, /connection was lost during an active turn/)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await appServer.stop()
  }
})

test('contains simultaneous transport closes from two Codex targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-codex-dual-disconnect-'))
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  const clients = [client(join(root, 'main-state.json')), client(join(root, 'mate-state.json'))]
  const events: CodexChannelEvent[][] = [[], []]
  const targets = clients.map((appServer, index) => {
    const dir = join(root, String(index))
    mkdirSync(dir)
    return target(dir, appServer, events[index])
  })
  try {
    const deliveries = targets.map(runtime => runtime.deliver({ content: 'wait-for-interrupt', meta: {} }))
    while (events.some(list => !list.some(event => event.type === 'turn-started'))) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (const appServer of clients) {
      const error = new Error('simultaneous local WebSocket reset')
      ;(appServer as any).failAll(error)
      appServer.emit('transport-close', { transport: 'websocket', error })
    }
    const settled = await Promise.allSettled(deliveries)
    assert.ok(settled.every(result => result.status === 'rejected' && /connection was lost/.test(String(result.reason))))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await Promise.all(clients.map(appServer => appServer.stop()))
  }
})

test('waits for a TUI-owned turn before starting a Telegram turn on the shared thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ka-codex-shared-thread-'))
  const events: CodexChannelEvent[] = []
  const appServer = client(join(dir, 'fake-state.json'))
  const runtime = target(dir, appServer, events)
  await runtime.deliver({ content: 'seed', meta: {} })
  events.length = 0
  const threadId = new BindingStore(join(dir, 'bindings.json')).list()[0].runtimeSessionId
  appServer.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: 'tui-turn' } } })
  const telegramTurn = runtime.deliver({ content: 'from-telegram', meta: {} })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(events.some(event => event.type === 'turn-started'), false)
  appServer.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'tui-turn', status: 'completed' } } })
  await telegramTurn
  assert.equal(events.find(event => event.type === 'final')?.text, 'echo:from-telegram')
  await appServer.stop()
})
