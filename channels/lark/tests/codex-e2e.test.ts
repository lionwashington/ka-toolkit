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
    assert.ok(calls.includes('**[#1-codex-reviewer]**\\n\\necho:hello-lark'),
      `channel prefix must be a separate CardKit paragraph: ${calls}`)
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

test('Lark falls back to the webhook when an established CardKit stream cannot update', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ka-lark-codex-update-fallback-'))
  const webhook = await startMockWebhook()
  const daemon = await startDaemon({
    webhookUrl: webhook.url,
    pollIntervalSeconds: 0.05,
    cardKitUpdateFail: true,
  })
  const appServer = await registerFake(daemon, workspace, 'codex-reviewer')
  try {
    assert.equal(await waitForReady(daemon.baseUrl), true)
    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_update_fallback',
      text: 'to codex-reviewer: update-fallback',
      createTime: '2030-01-01 00:03',
    })])
    const delivered = await waitFor(() => webhook.sent().some(message => message.text.includes('echo:update-fallback')), 10_000)
    assert.equal(delivered, true, `sent=${JSON.stringify(webhook.sent())}\napi=${daemon.apiCalls()}`)
    assert.match(daemon.apiCalls(), /PUT\t\/open-apis\/cardkit\/v1\/cards\/card-1\/elements\/content\/content/)
  } finally {
    await daemon.stop()
    await appServer.close()
    await webhook.close()
  }
})

test('Lark closes Codex streams that complete or fail without an agent text delta', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ka-lark-codex-empty-'))
  const webhook = await startMockWebhook()
  const daemon = await startDaemon({ webhookUrl: webhook.url, pollIntervalSeconds: 0.05 })
  const appServer = await registerFake(daemon, workspace, 'codex-reviewer')
  try {
    assert.equal(await waitForReady(daemon.baseUrl), true)
    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_empty',
      text: 'to codex-reviewer: complete-without-text',
      createTime: '2030-01-01 00:04',
    })])
    const closed = await waitFor(() =>
      daemon.apiCalls().includes('Codex completed without a text response.') &&
      daemon.apiCalls().includes('/settings'), 10_000)
    assert.equal(closed, true, daemon.apiCalls())

    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_failed_empty',
      text: 'to codex-reviewer: fail-without-text',
      createTime: '2030-01-01 00:05',
    })])
    const failedClosed = await waitFor(() =>
      daemon.apiCalls().includes('Codex turn failed without a text response.') &&
      daemon.apiCalls().split('\n').filter(line => line.includes('/settings')).length >= 2, 10_000)
    assert.equal(failedClosed, true, daemon.apiCalls())
  } finally {
    await daemon.stop()
    await appServer.close()
    await webhook.close()
  }
})

test('Lark routes Codex approvals, images, and interrupt controls end to end', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ka-lark-codex-controls-'))
  const webhook = await startMockWebhook()
  const daemon = await startDaemon({ webhookUrl: webhook.url, pollIntervalSeconds: 0.05 })
  const appServer = await registerFake(daemon, workspace, 'codex-reviewer')
  try {
    assert.equal(await waitForReady(daemon.baseUrl), true)

    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_approval', text: 'to codex-reviewer: approve-me', createTime: '2030-01-01 00:05',
    })])
    assert.equal(await waitFor(() => webhook.sent().some(message => message.text.includes('requests approval 1')), 10_000), true)
    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_approve', text: 'to codex-reviewer: /approve 1', createTime: '2030-01-01 00:06',
    })])
    assert.equal(await waitFor(() => daemon.apiCalls().includes('echo:approve-me'), 10_000), true)

    daemon.pushMessages('oc_test', [{
      message_id: 'om_image',
      message_position: '3',
      create_time: '2030-01-01 00:07',
      sender: { id: 'ou_test_self', sender_type: 'user', name: 'Owner' },
      msg_type: 'image',
      content: '[Image: img_codex_test]',
    }])
    assert.equal(await waitFor(() =>
      daemon.apiCalls().includes('echo:[image]|localImage:') && daemon.apiCalls().includes('om_image'), 10_000), true)

    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_wait', text: 'to codex-reviewer: wait-for-interrupt', createTime: '2030-01-01 00:08',
    })])
    assert.equal(await waitFor(() => daemon.apiCalls().split('\n').filter(line => line.includes('/messages')).length >= 3, 10_000), true)
    daemon.pushMessages('oc_test', [ownerMsg({
      mid: 'om_stop', text: 'to codex-reviewer: /stop', createTime: '2030-01-01 00:09',
    })])
    assert.equal(await waitFor(() => webhook.sent().some(message => message.text.includes('Interrupt requested.')), 10_000), true)
    assert.equal(await waitFor(() => daemon.apiCalls().includes('Codex turn interrupted.'), 10_000), true)
  } finally {
    await daemon.stop()
    await appServer.close()
    await webhook.close()
  }
})
