// e2e characterization for lark-channel: full black-box flow against a spawned
// channel-core daemon wired to LarkPlatform, with a fake lark-cli (canned inbound)
// + a mock Lark webhook (captures outbound). Asserts OBSERVABLE behavior only.
//
// Run: node --experimental-strip-types --test tests/e2e.test.ts
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  startMockWebhook, startDaemon, connectClient, ownerMsg, waitFor,
  type MockWebhook, type Daemon, type ChannelClient,
} from './harness.ts'

let webhook: MockWebhook
let daemon: Daemon
let main: ChannelClient
let ka: ChannelClient
const CHAT = 'oc_test'
const SELF = 'ou_test_self'

// Lark create_time is minute precision; the daemon anchors its watermark at NOW on
// first poll, so test messages must carry a create_time AFTER that. Use fixed future
// minutes (and bump per message) so each new message clears the watermark.
let futureMin = 0
function nextTime(): string {
  futureMin += 1
  const d = new Date(Date.UTC(2030, 0, 1, 0, futureMin, 0))
  // "YYYY-MM-DD HH:MM" (space, minute precision — matches lark)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

before(async () => {
  webhook = await startMockWebhook()
  daemon = await startDaemon({ webhookUrl: webhook.url, selfOpenId: SELF, chatId: CHAT, pollIntervalSeconds: 1 })
  main = await connectClient(daemon.baseUrl, 'main')
  ka = await connectClient(daemon.baseUrl, 'ka')
  await waitFor(() => false, 400).catch(() => {})  // let both sessions register
})

after(async () => {
  await main?.close()
  await ka?.close()
  await daemon?.stop()
  await webhook?.close()
})

describe('inbound (lark-cli poll → dispatch)', () => {
  // B: a bare message with no remembered target for this chat must NOT silently
  // default — the group gets a "pick a channel" prompt. Runs first (last_target unset).
  test('bare message with no last_target → pick-a-channel prompt, no delivery', async () => {
    const before = webhook.sent().length
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'm0', text: 'no target yet', createTime: nextTime(), selfOpenId: SELF })])
    const prompted = await waitFor(() => webhook.sent().slice(before).some(s => /no target remembered/i.test(s.text)), 5000)
    assert.ok(prompted, 'owner should be prompted to pick a channel')
    assert.ok(!main.received.some(r => r.content === 'no target yet'), 'no silent default to main')
  })

  test('explicit `to main:` → delivered to main with meta', async () => {
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'm1', text: 'to main: hello lark', createTime: nextTime(), selfOpenId: SELF })])
    const ok = await waitFor(() => main.received.some(r => r.content === 'hello lark'), 5000)
    assert.ok(ok, 'main should receive the owner message')
    const got = main.received.find(r => r.content === 'hello lark')!
    assert.equal(got.meta.chat_id, CHAT, 'meta.chat_id is the lark group (reply routes back here)')
    assert.equal(got.meta.message_id, 'm1')
    // 🔴 meta all-string invariant
    for (const v of Object.values(got.meta)) assert.equal(typeof v, 'string')
  })

  // sticky: after `to main:`, a bare follow-up in the SAME chat reuses main.
  test('bare follow-up after `to main:` is sticky → delivered to main', async () => {
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'm1b', text: 'sticky lark follow-up', createTime: nextTime(), selfOpenId: SELF })])
    const ok = await waitFor(() => main.received.some(r => r.content === 'sticky lark follow-up'), 5000)
    assert.ok(ok, 'bare follow-up should stick to main')
  })

  test('non-owner message → dropped (self-filter)', async () => {
    const before = main.received.length
    daemon.pushMessages(CHAT, [{
      message_id: 'm-other', create_time: nextTime(),
      sender: { id: 'ou_someone_else', sender_type: 'user', name: 'Bob' }, content: 'not from owner',
    }])
    await waitFor(() => false, 2500).catch(() => {})  // give it a few polls
    assert.ok(!main.received.some(r => r.content === 'not from owner'), 'non-owner message must not be delivered')
    assert.equal(main.received.length, before, 'no new delivery')
  })

  test('same message_id is not re-delivered (dedup ring) across repeated polls', async () => {
    const t = nextTime()
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'm-dup', text: 'to main: only once', createTime: t, selfOpenId: SELF })])
    await waitFor(() => main.received.some(r => r.content === 'only once'), 5000)
    // the fake CLI keeps returning the same message every poll for ~3s more
    await waitFor(() => false, 3000).catch(() => {})
    const count = main.received.filter(r => r.content === 'only once').length
    assert.equal(count, 1, 'must be delivered exactly once despite repeated polls')
  })
})

describe('inbound attachments', () => {
  test('image message (sticky to main) → downloaded, delivered to main with meta.attachment_path + [image] placeholder', async () => {
    // captionless images carry no routing signal → they follow the chat's sticky target;
    // establish it with an explicit `to main:` text first.
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'm-img-pre', text: 'to main: pics incoming', createTime: nextTime(), selfOpenId: SELF })])
    await waitFor(() => main.received.some(r => r.content === 'pics incoming'), 5000)
    daemon.pushMessages(CHAT, [{
      message_id: 'm-img', create_time: nextTime(),
      sender: { id: SELF, sender_type: 'user', name: 'Owner' },
      msg_type: 'image', content: '[Image: img_test_abc123]',
    }])
    const ok = await waitFor(() => main.received.some(r => r.meta.attachment_path), 6000)
    assert.ok(ok, 'main should receive a message carrying meta.attachment_path')
    const got = main.received.find(r => r.meta.attachment_path)!
    assert.equal(got.content, '[image]', 'no caption → English placeholder')
    assert.match(got.meta.attachment_path, /attachments\//, 'attachment_path points into the daemon attachments dir')
    assert.equal(got.meta.attachment_kind, 'image')
    assert.equal(got.meta.message_id, 'm-img')
    for (const v of Object.values(got.meta)) assert.equal(typeof v, 'string')  // meta all-string invariant
  })
})

describe('routing', () => {
  test('"to ka:" prefix → delivered to ka, not main', async () => {
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'm-route', text: 'to ka: routed body', createTime: nextTime(), selfOpenId: SELF })])
    const ok = await waitFor(() => ka.received.some(r => r.content === 'routed body'), 5000)
    assert.ok(ok, 'ka should receive the routed message body')
    assert.ok(!main.received.some(r => r.content === 'routed body'), 'main should NOT receive it')
  })
})

describe('attachment routing follows the last text (option B)', () => {
  const img = (mid: string, key: string) => ({
    message_id: mid, create_time: nextTime(),
    sender: { id: SELF, sender_type: 'user', name: 'Owner' },
    msg_type: 'image', content: `[Image: ${key}]`,
  })
  test('`to ka:` points images at ka; a later `to main:` resets them to main', async () => {
    // a text routed to ka → this chat's subsequent attachments go to ka
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'b-text1', text: 'to ka: incoming pics', createTime: nextTime(), selfOpenId: SELF })])
    await waitFor(() => ka.received.some(r => r.content === 'incoming pics'), 5000)
    daemon.pushMessages(CHAT, [img('b-img1', 'img_b_1')])
    assert.ok(await waitFor(() => ka.received.some(r => r.meta.message_id === 'b-img1' && r.meta.attachment_path), 6000), 'image1 → ka (follows the to-ka text)')
    assert.ok(!main.received.some(r => r.meta.message_id === 'b-img1'), 'image1 must NOT go to main')
    // v4 cross-channel isolation: saved under attachments/<channel>/ (here ka)
    assert.match(ka.received.find(r => r.meta.message_id === 'b-img1')!.meta.attachment_path, /attachments\/ka\//, 'image1 lands in the ka subdir')

    // a later explicit `to main:` re-points attachments back to main (the v3 fix; under
    // sticky routing a BARE text would keep following ka, so the re-point must be explicit)
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'b-text2', text: 'to main: back to main now', createTime: nextTime(), selfOpenId: SELF })])
    await waitFor(() => main.received.some(r => r.content === 'back to main now'), 5000)
    daemon.pushMessages(CHAT, [img('b-img2', 'img_b_2')])
    assert.ok(await waitFor(() => main.received.some(r => r.meta.message_id === 'b-img2' && r.meta.attachment_path), 6000), 'image2 → main (the `to main:` text reset the target)')
    assert.ok(!ka.received.some(r => r.meta.message_id === 'b-img2'), 'image2 must NOT stick to ka')
    assert.match(main.received.find(r => r.meta.message_id === 'b-img2')!.meta.attachment_path, /attachments\/main\//, 'image2 lands in the main subdir')
  })

  // 甲: a MULTI-target text does NOT re-point attachments (multi never becomes sticky).
  // The image follows the prior SINGLE target, not the multi list.
  test('a multi-target text does NOT re-point images (they follow the last single target)', async () => {
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'c-text1', text: 'to ka: single anchor', createTime: nextTime(), selfOpenId: SELF })])
    await waitFor(() => ka.received.some(r => r.content === 'single anchor'), 5000)
    // multi-target text: delivered to both, but must NOT change the sticky target.
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'c-text2', text: 'to main, ka: multi text', createTime: nextTime(), selfOpenId: SELF })])
    await waitFor(() => main.received.some(r => r.content === 'multi text') && ka.received.some(r => r.content === 'multi text'), 5000)
    daemon.pushMessages(CHAT, [img('c-img', 'img_c_1')])
    assert.ok(await waitFor(() => ka.received.some(r => r.meta.message_id === 'c-img' && r.meta.attachment_path), 6000),
      'image → ka (the prior SINGLE target, not the multi list)')
    assert.ok(!main.received.some(r => r.meta.message_id === 'c-img'),
      'image must NOT follow the multi-target text to main')
  })
})

describe('multi-target routing', () => {
  test('`to main, ka:` → BOTH main and ka receive the body', async () => {
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'mt-1', text: 'to main, ka: multi hello', createTime: nextTime(), selfOpenId: SELF })])
    assert.ok(await waitFor(() => main.received.some(r => r.content === 'multi hello'), 5000), 'main receives it')
    assert.ok(await waitFor(() => ka.received.some(r => r.content === 'multi hello'), 5000), 'ka receives the same body')
  })
  test('partial: `to main, ghost` → main delivered, a not-found notice for ghost goes back', async () => {
    const before = webhook.sent().length
    daemon.pushMessages(CHAT, [ownerMsg({ mid: 'mt-2', text: 'to main, ghost: partial msg', createTime: nextTime(), selfOpenId: SELF })])
    assert.ok(await waitFor(() => main.received.some(r => r.content === 'partial msg'), 5000), 'online target main delivered')
    assert.ok(!ka.received.some(r => r.content === 'partial msg'), 'unmatched target not delivered to ka')
    const ok = await waitFor(
      () => webhook.sent().slice(before).some(s => /not found/i.test(s.text) && /ghost/.test(s.text)),
      4000)
    assert.ok(ok, 'a "not found: ghost" notice is posted back to the group')
  })
})

describe('outbound (reply → webhook)', () => {
  test('reply tool → POST to the group webhook, prefixed with channel tag', async () => {
    const before = webhook.sent().length
    const res: any = await main.client.callTool({ name: 'reply', arguments: { chat_id: CHAT, text: 'a reply' } })
    assert.ok(!res.isError, `reply should succeed: ${JSON.stringify(res)}`)
    const ok = await waitFor(() => webhook.sent().length > before, 4000)
    assert.ok(ok, 'webhook should receive the reply POST')
    const last = webhook.sent()[webhook.sent().length - 1]
    assert.match(last.text, /a reply/, 'webhook body contains the reply text')
    assert.match(last.text, /\[#\d+-main\]/, 'reply is auto-prefixed with the channel number-name tag')
  })

  test('reply to an unconfigured chat_id → rejected (resolveReplyTarget null)', async () => {
    const res: any = await main.client.callTool({ name: 'reply', arguments: { chat_id: 'oc_unknown', text: 'nope' } })
    assert.ok(res.isError, 'reply to a non-configured group must be rejected')
  })

  // /api/send — Stop-hook reply-repair path on LARK: proves kind-awareness (the SAME
  // endpoint sends via the lark webhook here, telegram bot elsewhere — caller picks no
  // platform). Re-sends a leaked reply + enforces the same resolveReplyTarget policy.
  test('/api/send re-sends a leaked reply via the lark webhook (hook repair path)', async () => {
    const before = webhook.sent().length
    const r = await fetch(`${daemon.baseUrl}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'main', target: CHAT, text: 'leaked lark 77' }),
    })
    assert.equal(r.ok, true)
    assert.equal((await r.json() as any).ok, true)
    const ok = await waitFor(() => webhook.sent().slice(before).some(s => /leaked lark 77/.test(s.text)), 4000)
    assert.ok(ok, 'webhook should receive the re-sent leaked reply')
    const sent = webhook.sent().slice(before).find(s => /leaked lark 77/.test(s.text))!
    assert.match(sent.text, /\[#\d+-main\]/, 're-sent reply carries the [#num-name] prefix')
  })

  test('/api/send to an unconfigured group → 403 (same resolveReplyTarget policy)', async () => {
    const r = await fetch(`${daemon.baseUrl}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'main', target: 'oc_unknown', text: 'nope' }),
    })
    assert.equal(r.status, 403)
  })
})
