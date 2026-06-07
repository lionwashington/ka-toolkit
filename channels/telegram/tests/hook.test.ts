// e2e for the reply-repair Stop hook (channels/ops/reply-repair-hook.py): given a
// transcript where the model leaked a `reply` as TEXT, the hook must re-send it via the
// daemon /api/send (→ mock telegram), exactly once, and skip when a real reply already
// went out. Pure deterministic path — no LLM. Run: node --experimental-strip-types --test tests/hook.test.ts
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startMockTelegram, startDaemon, connectClient, waitFor,
  type MockTelegram, type Daemon, type ChannelClient } from './harness.ts'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ops', 'reply-repair-hook.py')
const OWNER = '12345'
let mock: MockTelegram, daemon: Daemon, main: ChannelClient

before(async () => {
  mock = await startMockTelegram()
  daemon = await startDaemon({ apiRoot: mock.url, ownerChatId: OWNER })
  main = await connectClient(daemon.baseUrl, 'main')  // registers channel "main" #1
  await waitFor(async () => false, 300).catch(() => {})
})
after(async () => { await main?.close(); await daemon?.stop(); await mock?.close() })

// Run the hook ASYNC (not spawnSync): spawnSync would block this process's event loop,
// which also hosts the in-process mock telegram — the daemon's send to the mock would
// then stall until the hook process exits, falsely hanging /api/send. Async spawn keeps
// the loop free so the mock can answer while the hook's HTTP call is in flight.
function runHook(lines: object[], opts: { home?: string } = {}): Promise<void> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'hook-home-'))
  const tpath = join(home, 'transcript.jsonl')
  writeFileSync(tpath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return new Promise<void>((resolve) => {
    const p = spawn('python3', [HOOK], {
      env: { ...process.env, KA_CHANNEL: 'main', KA_CHANNEL_PORT: String(daemon.port), KA_HOME: home },
    })
    p.on('close', () => resolve())
    p.on('error', () => resolve())
    p.stdin.end(JSON.stringify({ transcript_path: tpath, session_id: 'sess-test', cwd: home }))
  })
}
const userMsg = (t: string) => ({ message: { role: 'user', content: [{ type: 'text', text: t }] } })
const leakMsg = (chatId: string, text: string) => ({ message: { role: 'assistant', content: [
  { type: 'text', text: `card\n<invoke name="mcp__telegram-channel__reply">\n<parameter name="chat_id">${chatId}</parameter>\n<parameter name="text">${text}</parameter>\n</invoke>` },
] } })
const realReply = (text: string) => ({ message: { role: 'assistant', content: [
  { type: 'tool_use', name: 'mcp__telegram-channel__reply', input: { chat_id: OWNER, text } },
] } })

describe('reply-repair Stop hook', () => {
  test('leaked reply → re-sent via /api/send with [#num-name] prefix', async () => {
    const before = mock.sent().length
    await runHook([userMsg('hi'), leakMsg(OWNER, 'repaired msg A')])
    const ok = await waitFor(() => mock.sent().slice(before).some(m => m.text.includes('repaired msg A')))
    assert.ok(ok, 'hook should have re-sent the leaked reply')
    assert.match(mock.sent().slice(before).find(m => m.text.includes('repaired msg A'))!.text, /\[#1-main\]/)
  })

  test('dedup: same leak run twice → sent exactly once (shared KA_HOME state)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'))
    const before = mock.sent().length
    await runHook([userMsg('hi'), leakMsg(OWNER, 'dedup msg B')], { home })
    await runHook([userMsg('hi'), leakMsg(OWNER, 'dedup msg B')], { home })  // same session+text+home
    await waitFor(() => mock.sent().slice(before).some(m => m.text.includes('dedup msg B')))
    const n = mock.sent().slice(before).filter(m => m.text.includes('dedup msg B')).length
    assert.equal(n, 1, 'must re-send exactly once across two hook firings')
  })

  test('retry already succeeded (leak + real tool_use same text) → NOT re-sent', async () => {
    const before = mock.sent().length
    await runHook([userMsg('hi'), leakMsg(OWNER, 'no-dup msg C'), realReply('no-dup msg C')])
    await waitFor(async () => false, 600).catch(() => {})
    assert.equal(mock.sent().slice(before).filter(m => m.text.includes('no-dup msg C')).length, 0,
      'hook must NOT re-send when a real reply with the same text already went out')
  })

  test('no leak (clean turn) → no send', async () => {
    const before = mock.sent().length
    await runHook([userMsg('hi'), { message: { role: 'assistant', content: [{ type: 'text', text: 'just a normal answer' }] } }])
    await waitFor(async () => false, 400).catch(() => {})
    assert.equal(mock.sent().slice(before).length, 0, 'clean turn triggers no re-send')
  })

  test('non-channel session (no KA_CHANNEL env) → no-op', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'))
    const tpath = join(home, 't.jsonl')
    writeFileSync(tpath, JSON.stringify(leakMsg(OWNER, 'should-not-send D')) + '\n')
    const before = mock.sent().length
    await new Promise<void>((resolve) => {
      const p = spawn('python3', [HOOK], { env: { ...process.env, KA_CHANNEL: '', KA_CHANNEL_PORT: '', KA_HOME: home } })
      p.on('close', () => resolve()); p.on('error', () => resolve())
      p.stdin.end(JSON.stringify({ transcript_path: tpath, session_id: 's', cwd: home }))
    })
    await waitFor(async () => false, 400).catch(() => {})
    assert.equal(mock.sent().slice(before).filter(m => m.text.includes('should-not-send D')).length, 0)
  })
})
