import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const selector = fileURLToPath(new URL('../workshop/ops/runtimes/codex/select-thread.mjs', import.meta.url))
for (const scenario of ['owner', 'explicit', 'wrong-cwd', 'fresh']) {
  test(`selector subprocess: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ka-thread-test-'))
    try {
      const owner = join(root, 'owner')
      const journal = join(root, 'requests.jsonl')
      const shim = join(root, 'websocket.mjs')
      if (scenario !== 'fresh') writeFileSync(owner, 'saved-thread\n')
      writeFileSync(shim, `
import { appendFileSync } from 'node:fs';
globalThis.WebSocket = class extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(raw) {
    const req = JSON.parse(raw);
    appendFileSync(process.env.TEST_JOURNAL, raw + '\\n');
    if (!req.id) return;
    const result = req.method === 'thread/list' ? { data: [] } :
      req.method.startsWith('thread/') ? { thread: { id: req.params.threadId, cwd: process.env.TEST_WRONG ? '/synthetic/wrong' : '/synthetic/work' } } : {};
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: req.id, result }) })));
  }
  close() {}
};`)
      const result = spawnSync(process.execPath, ['--import', shim, selector, 'ws://synthetic', '/synthetic/work', scenario === 'explicit' ? 'explicit-thread' : ''], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, KA_CODEX_THREAD_OWNER_FILE: owner, KA_CODEX_MODEL: 'synthetic-model', TEST_JOURNAL: journal, TEST_WRONG: scenario === 'wrong-cwd' ? '1' : '' },
      })
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse)
      if (scenario === 'wrong-cwd') {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /another workspace/)
        assert.equal(requests.some(r => r.method === 'thread/resume'), false)
      } else {
        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        if (scenario === 'fresh') assert.equal(output.fresh, true)
        else {
          const id = scenario === 'explicit' ? 'explicit-thread' : 'saved-thread'
          assert.equal(output.id, id)
          assert.equal(requests.some(r => r.method === 'thread/list'), false)
          assert.deepEqual(requests.find(r => r.method === 'thread/resume').params, { threadId: id, model: 'synthetic-model' })
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
