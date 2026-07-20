import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectClient, startDaemon, startMockTelegram, waitFor } from './harness.ts'
import { startFakeSocketServer } from '../../../tests/codex-app-server/fake-socket-server.mjs'

const fake = fileURLToPath(new URL('../../../tests/codex-app-server/fake-app-server.mjs', import.meta.url))

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return predicate()
}

test('Telegram routes an owner message through a persistent Codex target', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ka-telegram-codex-'))
  const telegram = await startMockTelegram()
  const socketPath = join(workspace, 'app-server.sock')
  const statePath = join(workspace, 'fake-state.json')
  writeFileSync(statePath, JSON.stringify({ threads: { 'thread-1': { id: 'thread-1', ephemeral: false, path: '/tmp/thread-1.jsonl', cwd: workspace } } }))
  const appServer = await startFakeSocketServer({ socketPath, fakePath: fake, statePath })
  const daemon = await startDaemon({
    apiRoot: telegram.url,
  })
  try {
    const registered = await fetch(`${daemon.baseUrl}/api/runtimes/codex`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'codex-main', cwd: workspace, socket_path: socketPath, thread_id: 'thread-1' }),
    })
    assert.equal(registered.ok, true, await registered.text())
    const online = await waitForAsync(async () => {
      const status = await fetch(`${daemon.baseUrl}/api/status`).then(response => response.json())
      return Boolean(status.last_poll_at) && status.runtime_targets?.some((target: any) => target.name === 'codex-main' && target.alive)
    }, 5_000)
    assert.equal(online, true)
    await assert.rejects(connectClient(daemon.baseUrl, 'codex-main'), /409|conflict|already owned/i)
    const push = (id: number, text: string) => telegram.push({
      update_id: id,
      message: { message_id: id, date: Math.floor(Date.now() / 1000), from: { id: 12345 }, chat: { id: 12345 }, text },
    })
    push(1, 'to codex-main: hello')
    const replied = await waitFor(() => telegram.sent().some(message => message.text.includes('echo:hello')), 5_000)
    const log = (() => { try { return readFileSync(join(daemon.dataDir, 'channel.log'), 'utf8') } catch { return '' } })()
    assert.equal(replied, true, `sent=${JSON.stringify(telegram.sent())}\nlog=${log}`)
    assert.equal(telegram.sent().filter(message => message.text.includes('echo:hello')).length, 1)

    push(2, 'to codex-main: approve-me')
    assert.equal(await waitFor(() => telegram.sent().some(message => message.text.includes('requests approval 1')), 5_000), true)
    push(3, 'to codex-main: /approve 1')
    const approved = await waitFor(() => telegram.sent().some(message => message.text.includes('echo:approve-me')), 5_000)
    const approvalLog = (() => { try { return readFileSync(join(daemon.dataDir, 'channel.log'), 'utf8') } catch { return '' } })()
    assert.equal(approved, true, `sent=${JSON.stringify(telegram.sent())}\nlog=${approvalLog}`)

    push(4, 'to codex-main: wait-for-interrupt')
    await new Promise(resolve => setTimeout(resolve, 100))
    push(5, 'to codex-main: /stop')
    assert.equal(await waitFor(() => telegram.sent().some(message => message.text.includes('Interrupt requested.')), 5_000), true)
  } finally {
    await daemon.stop()
    await appServer.close()
    await telegram.close()
  }
})
