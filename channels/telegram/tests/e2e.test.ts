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
  test('ListTools exposes reply + send_to_channel + list_channels', async () => {
    const res = await main.client.listTools()
    const names = res.tools.map(t => t.name).sort()
    assert.deepEqual(names, ['list_channels', 'reply', 'send_to_channel'])
    const reply = res.tools.find(t => t.name === 'reply')!
    assert.deepEqual((reply.inputSchema as any).required, ['chat_id', 'text'])
    const stc = res.tools.find(t => t.name === 'send_to_channel')!
    assert.deepEqual((stc.inputSchema as any).required, ['target', 'text'])
    const lc = res.tools.find(t => t.name === 'list_channels')!
    assert.ok(lc, 'list_channels tool present')
    assert.deepEqual((lc.inputSchema as any).required ?? [], [], 'list_channels takes no required args')
  })

  test('list_channels returns the live roster with numbers', async () => {
    const res: any = await main.client.callTool({ name: 'list_channels', arguments: {} })
    const text = res.content.map((c: any) => c.text).join('\n')
    assert.match(text, /#1 main/, 'main listed as #1')
    assert.match(text, /#2 ka/, 'ka listed as #2')
    assert.match(text, /channel\(s\)/, 'has a header count')
  })
})

describe('inbound: Telegram → MCP notification (sticky routing)', () => {
  // B: a BARE owner message with no remembered target (fresh daemon, last_target
  // unset) must NOT silently default anywhere — the owner is prompted to pick a
  // channel and shown who is online. Runs first so last_target is still unset.
  test('bare text with no last_target → pick-a-channel prompt, no delivery', async () => {
    main.received.length = 0
    ka.received.length = 0
    const before = mock.sent().length
    pushOwnerText('hello with no target yet')
    const prompted = await waitFor(() =>
      mock.sent().slice(before).some(m => /no target remembered/i.test(m.text)))
    assert.ok(prompted, 'owner should be prompted to pick a channel')
    assert.equal(main.received.some(r => r.content === 'hello with no target yet'), false,
      'no silent default to main')
    assert.equal(ka.received.some(r => r.content === 'hello with no target yet'), false)
  })

  test('explicit `to main:` delivers to main + stringified meta (no source field)', async () => {
    main.received.length = 0
    pushOwnerText('to main: hello from owner')
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

  // sticky core: after a single `to main:`, a BARE follow-up reuses main.
  test('bare follow-up after `to main:` is sticky → delivered to main', async () => {
    main.received.length = 0
    pushOwnerText('sticky follow-up')
    const ok = await waitFor(() => main.received.some(r => r.content === 'sticky follow-up'))
    assert.ok(ok, 'bare follow-up should stick to main')
    assert.equal(main.received.find(r => r.content === 'sticky follow-up')!.meta.routed_target, 'main')
  })

  test('photo attachment (sticky to main) is downloaded; path + placeholder delivered', async () => {
    main.received.length = 0  // last_target=main from the prior test → bare photo sticks to main
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
    assert.equal(n.meta.attachment_kind, 'photo')
    assert.equal(readFileSync(n.meta.attachment_path, 'utf8'), 'MOCKIMGBYTES', 'file downloaded to disk')
  })

  test('voice attachment: download fails twice then succeeds → retry delivers path', async () => {
    main.received.length = 0  // last_target=main → bare voice sticks to main
    mock.failNextDownloads(2)  // first 2 file-fetches reset the socket ("fetch failed"); 3rd succeeds
    updateId += 1
    mock.push({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: Number(OWNER), first_name: 'Owner' },
        chat: { id: Number(OWNER) },
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voicefid', file_unique_id: 'vuq', duration: 3 },
      },
    })
    const ok = await waitFor(() => main.received.some(r => r.meta.attachment_path), 8000)
    assert.ok(ok, 'voice should be delivered with attachment_path after 2 retries')
    const n = main.received.find(r => r.meta.attachment_path)!
    assert.equal(n.content, '[voice]', 'no caption → [voice] placeholder')
    assert.equal(readFileSync(n.meta.attachment_path, 'utf8'), 'MOCKIMGBYTES', 'file saved on the 3rd attempt')
  })

  test('voice attachment: all attempts fail → text-only fail-safe (no path, notice appended)', async () => {
    main.received.length = 0
    mock.failNextDownloads(99)  // exhaust every retry
    updateId += 1
    mock.push({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: Number(OWNER), first_name: 'Owner' },
        chat: { id: Number(OWNER) },
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'voicefid2', file_unique_id: 'vuq2', duration: 3 },
      },
    })
    const ok = await waitFor(() => main.received.some(r => r.content.includes('[voice]')), 8000)
    assert.ok(ok, 'voice still delivered as text even when download fails')
    const n = main.received.find(r => r.content.includes('[voice]'))!
    assert.ok(!n.meta.attachment_path, 'no attachment_path on total failure')
    assert.match(n.content, /attachment download failed; text only/, 'fail-safe notice appended')
    mock.failNextDownloads(0)  // reset so later tests download normally
  })

  test('routing `to ka:` delivers to ka only, not main, and re-points sticky to ka', async () => {
    main.received.length = 0
    ka.received.length = 0
    pushOwnerText('to ka: routed message')
    const ok = await waitFor(() => ka.received.some(r => r.content === 'routed message'))
    assert.ok(ok, 'ka should receive the routed body')
    assert.equal(main.received.some(r => r.content === 'routed message'), false)
    const n = ka.received.find(r => r.content === 'routed message')!
    assert.equal(n.meta.channel_name, 'ka')
    assert.equal(n.meta.routed_target, 'ka')
    // sticky re-pointed: a bare follow-up now goes to ka, not main.
    main.received.length = 0
    ka.received.length = 0
    pushOwnerText('bare sticks to ka now')
    const ok2 = await waitFor(() => ka.received.some(r => r.content === 'bare sticks to ka now'))
    assert.ok(ok2, 'bare follow-up should stick to ka')
    assert.equal(main.received.some(r => r.content === 'bare sticks to ka now'), false)
  })

  // A: a MULTI-target send delivers to all listed but does NOT become sticky.
  test('multi-target `to main,ka:` delivers to both but does NOT change last_target', async () => {
    // anchor sticky on ka first
    pushOwnerText('to ka: anchor ka')
    await waitFor(() => ka.received.some(r => r.content === 'anchor ka'))
    main.received.length = 0
    ka.received.length = 0
    pushOwnerText('to main,ka: multi body')
    const both = await waitFor(() =>
      main.received.some(r => r.content === 'multi body') && ka.received.some(r => r.content === 'multi body'))
    assert.ok(both, 'both main and ka should receive the multi-target body')
    // bare follow-up must reuse the PRIOR single target (ka), proving multi was not recorded.
    main.received.length = 0
    ka.received.length = 0
    pushOwnerText('after multi bare')
    const ok = await waitFor(() => ka.received.some(r => r.content === 'after multi bare'))
    assert.ok(ok, 'bare follow-up sticks to the last SINGLE target (ka)')
    assert.equal(main.received.some(r => r.content === 'after multi bare'), false,
      'multi-target did not become sticky')
  })

  // D: `to all:` broadcasts but does NOT become sticky.
  test('`to all:` broadcasts but does NOT change last_target', async () => {
    pushOwnerText('to ka: anchor ka2')
    await waitFor(() => ka.received.some(r => r.content === 'anchor ka2'))
    main.received.length = 0
    ka.received.length = 0
    pushOwnerText('to all: broadcast body')
    const both = await waitFor(() =>
      main.received.some(r => r.content === 'broadcast body') && ka.received.some(r => r.content === 'broadcast body'))
    assert.ok(both, 'broadcast should reach both channels')
    main.received.length = 0
    ka.received.length = 0
    pushOwnerText('after all bare')
    const ok = await waitFor(() => ka.received.some(r => r.content === 'after all bare'))
    assert.ok(ok, 'bare follow-up sticks to ka, not the broadcast')
    assert.equal(main.received.some(r => r.content === 'after all bare'), false,
      '`to all` did not become sticky')
  })

  // C: when the remembered target is offline (here an unknown name), a bare message
  // is NOT delivered — the owner gets a "not found" + online list to re-pick.
  test('bare message whose last_target is offline → not found + online list, no delivery', async () => {
    // an explicit single target that is offline still becomes last_target (optimistic);
    // it surfaces immediately as not-found, and the next bare hits the same path.
    let before = mock.sent().length
    pushOwnerText('to ghost: ghost body')
    assert.ok(await waitFor(() => mock.sent().slice(before).some(m => /not found/i.test(m.text))),
      'offline explicit target → not found')
    main.received.length = 0
    ka.received.length = 0
    before = mock.sent().length
    pushOwnerText('bare after ghost')
    assert.ok(await waitFor(() => mock.sent().slice(before).some(m => /not found/i.test(m.text))),
      'bare with offline last_target → not found prompt')
    assert.equal(main.received.some(r => r.content === 'bare after ghost'), false)
    assert.equal(ka.received.some(r => r.content === 'bare after ghost'), false)
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

  // /api/send — the Stop-hook reply-repair path: re-send a reply the model leaked as
  // text. Goes through resolveReplyTarget + [#num-name] prefix + platform.send, same as
  // the reply tool, so it lands on the owner via the active platform (here telegram).
  test('/api/send re-sends a leaked reply with [#num-name] prefix (hook repair path)', async () => {
    const before = mock.sent().length
    const r = await fetch(`${daemon.baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'main', target: OWNER, text: 'leaked body 99' }),
    })
    assert.equal(r.ok, true)
    assert.equal((await r.json() as any).ok, true)
    const ok = await waitFor(() => mock.sent().slice(before).some(m => m.text.includes('leaked body 99')))
    assert.ok(ok, 'mock should receive the re-sent leaked reply')
    const sent = mock.sent().slice(before).find(m => m.text.includes('leaked body 99'))!
    assert.equal(sent.chat_id, OWNER)
    assert.match(sent.text, /\[#1-main\]/, 're-sent reply carries the [#num-name] prefix')
  })

  test('/api/send rejects missing target/text (400)', async () => {
    const r = await fetch(`${daemon.baseUrl}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'main', text: '' }),
    })
    assert.equal(r.status, 400)
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
          // explicit target: this test exercises the defer/replay OFFSET mechanism,
          // not routing defaults — a bare message with no last_target would (correctly)
          // hit the sticky "pick a channel" prompt instead of delivering.
          chat: { id: Number(OWNER) }, date: Math.floor(Date.now() / 1000), text: 'to main: replay me',
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
