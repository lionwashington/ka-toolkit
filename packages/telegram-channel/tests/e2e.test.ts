// e2e characterization: full black-box message flow against a spawned daemon
// pointed at a mock Telegram Bot API. Asserts OBSERVABLE behavior only (notif
// payloads, sent messages, API shapes) — NOT internal structures — so the
// channel-core extraction (R0+) can be proven behavior-preserving by re-running
// this same suite green.
//
// Run: node --experimental-strip-types --test tests/e2e.test.ts
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  startMockTelegram, startDaemon, connectClient, waitFor,
  type MockTelegram, type Daemon, type ChannelClient,
} from './harness.ts'

let mock: MockTelegram
let daemon: Daemon
let main: ChannelClient
let ka: ChannelClient
let updateId = 1000
const OWNER = '12345'

function pushOwnerText(text: string, opts: { message_id?: number } = {}) {
  updateId += 1
  mock.push({
    update_id: updateId,
    message: {
      message_id: opts.message_id ?? updateId,
      from: { id: Number(OWNER), first_name: 'Owner'},
      chat: { id: Number(OWNER) },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  })
}

before(async () => {
  mock = await startMockTelegram()
  daemon = await startDaemon({ apiRoot: mock.url, ownerChatId: OWNER })
  // main connects first → stable channel number #1; ka second → #2.
  main = await connectClient(daemon.baseUrl, 'main')
  ka = await connectClient(daemon.baseUrl, 'ka')
  // let both sessions register
  await waitFor(async () => false, 300).catch(() => {})
})

after(async () => {
  await main?.close()
  await ka?.close()
  await daemon?.stop()
  await mock?.close()
})

describe('HTTP /api/status', () => {
  test('reports both channels online with stable numbers', async () => {
    const r = await fetch(`${daemon.baseUrl}/api/status`)
    assert.equal(r.ok, true)
    const j: any = await r.json()
    assert.equal(j.ok, true)
    assert.equal(typeof j.pid, 'number')
    assert.equal(j.fifo_cap_per_name, 4)
    assert.ok('main' in j.channels_online, 'main should be online')
    assert.ok('ka' in j.channels_online, 'ka should be online')
    assert.equal(j.channel_numbers.main, 1)
    assert.equal(j.channel_numbers.ka, 2)
    // counters present
    for (const k of ['dispatches_total', 'replies_total', 'cc_dispatches_total', 'probe_reconnect_triggered_total']) {
      assert.equal(typeof j[k], 'number', `${k} should be a number`)
    }
  })
})

describe('MCP tools contract', () => {
  test('ListTools exposes reply + send_to_channel', async () => {
    const res = await main.client.listTools()
    const names = res.tools.map(t => t.name).sort()
    assert.deepEqual(names, ['reply', 'send_to_channel'])
    const reply = res.tools.find(t => t.name === 'reply')!
    assert.deepEqual((reply.inputSchema as any).required, ['chat_id', 'text'])
    const stc = res.tools.find(t => t.name === 'send_to_channel')!
    assert.deepEqual((stc.inputSchema as any).required, ['target', 'text'])
  })
})

describe('inbound: Telegram → MCP notification', () => {
  test('owner text dispatches to main with stringified meta (no source field)', async () => {
    main.received.length = 0
    pushOwnerText('hello from owner')
    const ok = await waitFor(() => main.received.some(r => r.content === 'hello from owner'))
    assert.ok(ok, 'main should receive the owner text')
    const n = main.received.find(r => r.content === 'hello from owner')!
    assert.equal(n.meta.channel_name, 'main')
    assert.equal(n.meta.routed_target, 'main')
    assert.equal(n.meta.chat_id, OWNER)
    assert.equal(n.meta.sender_id, OWNER)        // stringified
    assert.equal(typeof n.meta.ts, 'string')      // 🔴 meta all-string invariant
    // current behavior: the telegram inbound path does NOT set meta.source
    assert.equal(n.meta.source, undefined)
  })

  test('photo attachment is downloaded; path + placeholder delivered', async () => {
    main.received.length = 0
    updateId += 1
    mock.push({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: Number(OWNER), first_name: 'Owner'},
        chat: { id: Number(OWNER) },
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: 'small', file_unique_id: 'us' }, { file_id: 'large', file_unique_id: 'ulg' }],
      },
    })
    const ok = await waitFor(() => main.received.some(r => r.meta.attachment_path))
    assert.ok(ok, 'main should receive a notification with attachment_path')
    const n = main.received.find(r => r.meta.attachment_path)!
    assert.equal(n.content, '[image]', 'no caption → placeholder')
    assert.ok(n.meta.attachment_path.length > 0)
    assert.equal(readFileSync(n.meta.attachment_path, 'utf8'), 'MOCKIMGBYTES', 'file downloaded to disk')
  })

  test('routing `to ka:` delivers to ka only, not main', async () => {
    main.received.length = 0
    ka.received.length = 0
    pushOwnerText('to ka: routed message')
    const ok = await waitFor(() => ka.received.some(r => r.content === 'routed message'))
    assert.ok(ok, 'ka should receive the routed body')
    assert.equal(main.received.some(r => r.content === 'routed message'), false)
    const n = ka.received.find(r => r.content === 'routed message')!
    assert.equal(n.meta.channel_name, 'ka')
    assert.equal(n.meta.routed_target, 'ka')
  })
})

describe('outbound: reply → Telegram sendMessage', () => {
  test('reply sends prefixed text to the owner', async () => {
    const before = mock.sent().length
    const res: any = await main.client.callTool({ name: 'reply', arguments: { chat_id: OWNER, text: 'reply body 42' } })
    assert.equal(res.isError ?? false, false)
    const ok = await waitFor(() => mock.sent().slice(before).some(m => m.text.includes('reply body 42')))
    assert.ok(ok, 'mock should have received the reply')
    const sent = mock.sent().slice(before).find(m => m.text.includes('reply body 42'))!
    assert.equal(sent.chat_id, OWNER)
    assert.match(sent.text, /\[#1-main\]/, 'reply is prefixed with stable [#num-name]')
  })
})

describe('cc2cc: send_to_channel', () => {
  test('main → ka delivers source=cc + unspoofable from_channel', async () => {
    ka.received.length = 0
    const res: any = await main.client.callTool({ name: 'send_to_channel', arguments: { target: 'ka', text: 'cc hello' } })
    assert.equal(res.isError ?? false, false)
    const ok = await waitFor(() => ka.received.some(r => r.content === 'cc hello'))
    assert.ok(ok, 'ka should receive the cc message')
    const n = ka.received.find(r => r.content === 'cc hello')!
    assert.equal(n.meta.source, 'cc')
    assert.equal(n.meta.from_channel, 'main')
    assert.equal(n.meta.channel_name, 'ka')
  })

  test('send_to_channel to offline target → tool error with online list', async () => {
    const res: any = await main.client.callTool({ name: 'send_to_channel', arguments: { target: 'nope', text: 'x' } })
    assert.equal(res.isError, true)
    assert.match(res.content[0].text, /not online/i)
  })
})

describe('probe-M6: live client survives ping probe', () => {
  test('main still online + channel_alive after a full probe cycle', async () => {
    // PROBE_INTERVAL_MS=5000. A spec-compliant SDK client auto-answers the
    // server→client `ping` REQUEST, so it must NOT be falsely evicted — the core
    // M6 invariant (the old write-only probe couldn't even detect death; the new
    // ping probe must not over-correct and kill live consumers).
    await new Promise(r => setTimeout(r, 5500))
    const j: any = await (await fetch(`${daemon.baseUrl}/api/status`)).json()
    assert.ok('main' in j.channels_online, 'main still online after probe cycle')
    assert.equal(j.channel_alive.main, true, 'main reported alive (ping pong ok)')
  })
})

describe('offline replay (no MCP session)', () => {
  test('owner message pushed while no session connected is replayed on connect', async () => {
    const m2 = await startMockTelegram()
    const d2 = await startDaemon({ apiRoot: m2.url, ownerChatId: OWNER })
    try {
      await new Promise(r => setTimeout(r, 600))  // let anchorOffsetIfFresh settle
      m2.push({
        update_id: 7000,
        message: {
          message_id: 1, from: { id: Number(OWNER), first_name: 'L' },
          chat: { id: Number(OWNER) }, date: Math.floor(Date.now() / 1000), text: 'replay me',
        },
      })
      await new Promise(r => setTimeout(r, 1500))  // daemon polls, finds no session → defers (keeps offset)
      const c = await connectClient(d2.baseUrl, 'main')
      const ok = await waitFor(() => c.received.some(r => r.content === 'replay me'), 6000)
      assert.ok(ok, 'deferred message should replay after the client connects')
      await c.close()
    } finally {
      await d2.stop()
      await m2.close()
    }
  })
})

describe('404 self-heal', () => {
  test('unknown mcp-session-id → 404 force-reinit', async () => {
    const r = await fetch(`${daemon.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'mcp-session-id': 'bogus-session-id-zzz',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    })
    assert.equal(r.status, 404)
    const body: any = await r.json()
    assert.match(body.error.message, /reinitialize/i)
  })
})

describe('re-adopt: daemon must NOT 404 a consumer SSE reconnect carrying ?name', () => {
  // A dev-channels CONSUMER is a GET-only SSE listener. After a daemon restart it
  // reconnects with a STALE session-id (the new daemon has no memory of it) plus
  // ?name=<channel>. The OLD behavior 404'd that → the GET-only consumer gave up
  // (it never re-initializes like the tool client) → inbound silently died while
  // outbound still worked ("can send, can't receive"). RE-ADOPT rebuilds the
  // session from ?name and reopens the standalone SSE, so the consumer's own
  // one-shot reconnect succeeds with NO CC restart and NO manual touch. This guards
  // the "daemon never 404 a reconnect that tells us its channel" principle. It
  // lives in channel-core (the /mcp handler), so every platform inherits it.

  test('GET /mcp?name=X with unknown session-id + SSE accept → re-adopted (not 404), channel registers', async () => {
    const ac = new AbortController()
    const res = await fetch(`${daemon.baseUrl}/mcp?name=readopt-test`, {
      method: 'GET',
      headers: { 'mcp-session-id': 'stale-readopt-aaa', accept: 'text/event-stream' },
      signal: ac.signal,
    })
    assert.notEqual(res.status, 404, 'must NOT 404 a consumer SSE reconnect carrying ?name')
    assert.equal(res.status, 200, 're-adopt should open the standalone SSE (200)')
    // The re-adopted session registers under its channel → visible in /api/status.
    let online = false
    for (let i = 0; i < 40 && !online; i++) {
      const s: any = await (await fetch(`${daemon.baseUrl}/api/status`)).json()
      online = Boolean(s.channels_online?.['readopt-test'])
      if (!online) await new Promise(r => setTimeout(r, 100))
    }
    ac.abort()  // close the SSE stream
    assert.ok(online, 're-adopted consumer channel must be registered/online')
  })

  test('GET /mcp WITHOUT ?name (unknown session) → 404 (cannot re-adopt without a channel)', async () => {
    const res = await fetch(`${daemon.baseUrl}/mcp`, {
      method: 'GET',
      headers: { 'mcp-session-id': 'stale-readopt-bbb', accept: 'text/event-stream' },
    })
    assert.equal(res.status, 404, 'no ?name → not re-adoptable → 404')
    await res.text().catch(() => {})  // drain body
  })
})
