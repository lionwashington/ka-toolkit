// e2e for the reply-safety Stop hook (channels/ops/reply-safety-hook.py). Two branches:
//  · LEAK: a reply leaked as <invoke> TEXT → re-sent via daemon /api/send, once, skipped
//    when a real reply already went out.
//  · FORGOT: an owner channel message answered in terminal text with no reply → emits a
//    decision:block nudge, at most once per owner message; excludes parse-error/leak turns.
// Pure deterministic, no LLM. Run: node --experimental-strip-types --test tests/hook.test.ts
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startMockTelegram, startDaemon, connectClient, waitFor,
  type MockTelegram, type Daemon, type ChannelClient } from './harness.ts'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ops', 'reply-safety-hook.py')
const OWNER = '12345'
let mock: MockTelegram, daemon: Daemon, main: ChannelClient

before(async () => {
  mock = await startMockTelegram()
  daemon = await startDaemon({ apiRoot: mock.url, ownerChatId: OWNER })
  main = await connectClient(daemon.baseUrl, 'main')  // registers channel "main" #1
  await waitFor(async () => false, 300).catch(() => {})
})
after(async () => { await main?.close(); await daemon?.stop(); await mock?.close() })

// Run the hook ASYNC (not spawnSync — that would block this process's event loop which
// hosts the in-process mock telegram, falsely hanging /api/send). Returns the hook's
// stdout (the decision:block JSON, when it nudges).
function runHook(lines: object[], opts: { home?: string; channel?: string } = {}): Promise<string> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'hook-home-'))
  const tpath = join(home, 'transcript.jsonl')
  writeFileSync(tpath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return new Promise<string>((resolve) => {
    let out = ''
    const env: Record<string, string> = { ...process.env as Record<string, string>, KA_HOME: home }
    if (opts.channel !== '') { env.KA_CHANNEL = opts.channel ?? 'main'; env.KA_CHANNEL_PORT = String(daemon.port) }
    else { env.KA_CHANNEL = ''; env.KA_CHANNEL_PORT = '' }
    const p = spawn('python3', [HOOK], { env })
    p.stdout.on('data', d => { out += d })
    p.on('close', () => resolve(out))
    p.on('error', () => resolve(out))
    p.stdin.end(JSON.stringify({ transcript_path: tpath, session_id: 'sess-test', cwd: home }))
  })
}
const decision = (stdout: string) => { try { return JSON.parse(stdout.trim() || '{}') } catch { return {} } }

// helpers
const plainUser = (t: string) => ({ message: { role: 'user', content: [{ type: 'text', text: t }] } })
const ownerMsg = (t: string, mid = 'm1') => ({ message: { role: 'user', content: [
  { type: 'text', text: `<channel source="telegram-channel" chat_id="${OWNER}" sender_name="owner" sender_id="${OWNER}" message_id="${mid}">${t}</channel>` },
] } })
const asstText = (t: string) => ({ message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
const leakMsg = (chatId: string, text: string) => ({ message: { role: 'assistant', content: [
  { type: 'text', text: `card\n<invoke name="mcp__telegram-channel__reply">\n<parameter name="chat_id">${chatId}</parameter>\n<parameter name="text">${text}</parameter>\n</invoke>` },
] } })
const realReply = (text: string) => ({ message: { role: 'assistant', content: [
  { type: 'tool_use', name: 'mcp__telegram-channel__reply', input: { chat_id: OWNER, text } },
] } })
const ANSWER = '这是一条实质性的答案,超过三十个字符,模拟 main 把回答打在了终端里却忘了用 reply 工具发出去。'

describe('reply-safety hook — leak repair branch', () => {
  test('leaked reply → re-sent via /api/send with [#num-name] prefix', async () => {
    const before = mock.sent().length
    await runHook([plainUser('hi'), leakMsg(OWNER, 'repaired msg A')])
    const ok = await waitFor(() => mock.sent().slice(before).some(m => m.text.includes('repaired msg A')))
    assert.ok(ok, 'hook should have re-sent the leaked reply')
    assert.match(mock.sent().slice(before).find(m => m.text.includes('repaired msg A'))!.text, /\[#1-main\]/)
  })

  test('dedup: same leak run twice → sent exactly once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'))
    const before = mock.sent().length
    await runHook([plainUser('hi'), leakMsg(OWNER, 'dedup msg B')], { home })
    await runHook([plainUser('hi'), leakMsg(OWNER, 'dedup msg B')], { home })
    await waitFor(() => mock.sent().slice(before).some(m => m.text.includes('dedup msg B')))
    assert.equal(mock.sent().slice(before).filter(m => m.text.includes('dedup msg B')).length, 1)
  })

  test('retry already succeeded (leak + real tool_use same text) → NOT re-sent', async () => {
    const before = mock.sent().length
    await runHook([plainUser('hi'), leakMsg(OWNER, 'no-dup msg C'), realReply('no-dup msg C')])
    await waitFor(async () => false, 500).catch(() => {})
    assert.equal(mock.sent().slice(before).filter(m => m.text.includes('no-dup msg C')).length, 0)
  })

  test('non-channel session (no KA_CHANNEL) → no-op', async () => {
    const before = mock.sent().length
    const out = await runHook([plainUser('hi'), leakMsg(OWNER, 'should-not-send D')], { channel: '' })
    await waitFor(async () => false, 300).catch(() => {})
    assert.equal(mock.sent().slice(before).filter(m => m.text.includes('should-not-send D')).length, 0)
    assert.equal(decision(out).decision, undefined)
  })
})

describe('reply-safety hook — forgot-reply nudge branch', () => {
  test('owner msg answered in terminal, no reply → decision:block nudge', async () => {
    const out = await runHook([ownerMsg('今天进展如何?', 'mf1'), asstText(ANSWER)])
    const d = decision(out)
    assert.equal(d.decision, 'block', 'should nudge to reply')
    assert.match(d.reason, /reply/, 'reason instructs using the reply tool')
  })

  test('nudge fires at most once per owner message (no loop)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'))
    const d1 = decision(await runHook([ownerMsg('q', 'mf2'), asstText(ANSWER)], { home }))
    const d2 = decision(await runHook([ownerMsg('q', 'mf2'), asstText(ANSWER)], { home }))
    assert.equal(d1.decision, 'block', 'first fires')
    assert.equal(d2.decision, undefined, 'second gives up (no loop)')
  })

  test('parse-error turn (not a forget) → no nudge', async () => {
    const out = await runHook([ownerMsg('q', 'mf3'), asstText("The model's tool call could not be parsed (retry also failed).")])
    assert.equal(decision(out).decision, undefined)
  })

  test('non-reply tool leaked as text (Bash) + owner msg ignored → STILL nudges (2026-06-08 gap)', async () => {
    // main got stuck leaking a Bash call (poke story-maker) and never replied the owner.
    // The leaked <invoke name="Bash"> must NOT suppress the forgot-nudge (only reply leaks do).
    const bashLeak = asstText('还差最后一步,马上完成。\ncard\n<invoke name="Bash">\n<parameter name="command">ka workshop poke story-maker /compact</parameter>\n</invoke>')
    const out = await runHook([ownerMsg('帮我看下 story-maker 卡没卡', 'mb1'), bashLeak])
    assert.equal(decision(out).decision, 'block', 'a leaked Bash call must not swallow the owner reply')
  })

  test('reply leaked as text after owner msg → branch 1 re-sends, forgot does NOT also nudge', async () => {
    const out = await runHook([ownerMsg('q', 'mb2'), leakMsg(OWNER, 'forgot-vs-leak X')])
    assert.equal(decision(out).decision, undefined, 'reply leak is branch-1 territory; no double notify')
  })

  test('owner msg properly replied → no nudge', async () => {
    const out = await runHook([ownerMsg('q', 'mf4'), realReply('here is my proper answer')])
    assert.equal(decision(out).decision, undefined)
  })

  test('owner msg + only short text (<30 chars) → no nudge', async () => {
    const out = await runHook([ownerMsg('q', 'mf5'), asstText('好的')])
    assert.equal(decision(out).decision, undefined)
  })

  test('cc message (not owner) answered in terminal → no nudge', async () => {
    const cc = { message: { role: 'user', content: [{ type: 'text', text: '<channel source="cc" from_channel="freelancer">hey</channel>' }] } }
    const out = await runHook([cc, asstText(ANSWER)])
    assert.equal(decision(out).decision, undefined, 'cc messages do not require an owner reply')
  })

  test('LARK owner message answered in terminal → also nudges (platform-agnostic)', async () => {
    const larkOwner = { message: { role: 'user', content: [
      { type: 'text', text: `<channel source="lark-channel" chat_id="oc_grp" sender_name="owner" message_id="mlk1">${'问题'}</channel>` },
    ] } }
    const out = await runHook([larkOwner, asstText(ANSWER)])
    assert.equal(decision(out).decision, 'block', 'lark owner msg must nudge too (not just telegram)')
  })
})
