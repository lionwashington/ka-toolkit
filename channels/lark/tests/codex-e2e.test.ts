import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerMsg, startDaemon, startMockWebhook, waitFor } from './harness.ts'
import { startFakeSocketServer } from '../../../tests/codex-app-server/fake-socket-server.mjs'

const fake = fileURLToPath(new URL('../../../tests/codex-app-server/fake-app-server.mjs', import.meta.url))

async function registerFake(daemon: { baseUrl: string }, workspace: string, name: string) {
  const socketPath = join(workspace, 'app-server.sock')
  const statePath = join(workspace, 'fake-state.json')
  writeFileSync(statePath, JSON.stringify({ threads: { 'thread-1': { id: 'thread-1', ephemeral: false, path: '/tmp/thread-1.jsonl', cwd: workspace } } }))
  const server = await startFakeSocketServer({ socketPath, fakePath: fake, statePath })
  const response = await fetch(`${daemon.baseUrl}/api/runtimes/codex`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, cwd: workspace, socket_path: socketPath, thread_id: 'thread-1' }),
  })
  assert.equal(response.ok, true, await response.text())
  return server
}

async function waitForReady(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const status = await fetch(`${baseUrl}/api/status`).then(response => response.json())
    if (status.last_poll_at && status.runtime_targets?.some((target: any) => target.name === 'codex-reviewer' && target.alive)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

test('Lark routes a configured group through the shared Codex runtime bridge', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ka-lark-codex-'))
  const webhook = await startMockWebhook()
  const daemon = await startDaemon({
    webhookUrl: webhook.url,
    pollIntervalSeconds: 1,
  })
  const appServer = await registerFake(daemon, workspace, 'codex-reviewer')
  try {
    assert.equal(await waitForReady(daemon.baseUrl), true)
    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'codex-1',
      text: 'to codex-reviewer: hello-lark',
      createTime: '2030-01-01 00:01',
    })])
    assert.equal(await waitFor(() => daemon.apiCalls().includes('/settings'), 5_000), true)
    const calls = daemon.apiCalls()
    assert.match(calls, /POST\t\/open-apis\/cardkit\/v1\/cards/)
    assert.match(calls, /POST\t\/open-apis\/im\/v1\/messages/)
    assert.match(calls, /PUT\t\/open-apis\/cardkit\/v1\/cards\/card-1\/elements\/content\/content/)
    assert.match(calls, /PATCH\t\/open-apis\/cardkit\/v1\/cards\/card-1\/settings/)
  } finally {
    await daemon.stop()
    await appServer.close()
    await webhook.close()
  }
})

test('Lark falls back to final webhook delivery when CardKit is unavailable', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ka-lark-codex-fallback-'))
  const webhook = await startMockWebhook()
  const daemon = await startDaemon({
    webhookUrl: webhook.url,
    pollIntervalSeconds: 0.05,
    cardKitFail: true,
  })
  const appServer = await registerFake(daemon, workspace, 'codex-reviewer')
  try {
    assert.equal(await waitForReady(daemon.baseUrl), true)
    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_fallback',
      text: 'to codex-reviewer: fallback-check',
      createTime: '2030-01-01 00:02',
    })])
    const delivered = await waitFor(() => webhook.sent().some(message => message.text.includes('echo:fallback-check')), 10_000)
    assert.equal(delivered, true, `sent=${JSON.stringify(webhook.sent())}\napi=${daemon.apiCalls()}`)
    assert.match(daemon.apiCalls(), /POST\t\/open-apis\/cardkit\/v1\/cards/)
  } finally {
    await daemon.stop()
    await appServer.close()
    await webhook.close()
  }
})
