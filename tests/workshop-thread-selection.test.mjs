import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const selector = fileURLToPath(new URL('../workshop/ops/runtimes/codex/select-thread.mjs', import.meta.url))
for (const scenario of ['owner', 'explicit', 'wrong-cwd', 'fresh', 'missing-latest', 'missing-fresh', 'explicit-missing', 'owner-timeout', 'owner-other-error', 'resume-missing']) {
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
    const scenario = process.env.TEST_SCENARIO;
    const lookup = (req.method === 'thread/read' && scenario !== 'resume-missing') ||
      (req.method === 'thread/resume' && scenario === 'resume-missing');
    if (lookup && ['missing-latest','missing-fresh','explicit-missing','owner-timeout','owner-other-error','resume-missing'].includes(scenario) && req.params.threadId !== 'latest-thread') {
      if (scenario === 'owner-timeout') return;
      const error = { code: scenario === 'owner-other-error' ? -32603 : -32600,
        message: scenario === 'owner-other-error' ? 'internal storage failure' : 'no rollout found for thread id ' + req.params.threadId };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: req.id, error }) })));
      return;
    }
    const result = req.method === 'thread/list' ? { data: ['missing-latest','resume-missing'].includes(scenario) ? [{ id: 'latest-thread', cwd: '/synthetic/work' }] : [] } :
      req.method.startsWith('thread/') ? { thread: { id: req.params.threadId, cwd: process.env.TEST_WRONG ? '/synthetic/wrong' : '/synthetic/work' } } : {};
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: req.id, result }) })));
  }
  close() {}
};`)
      const result = spawnSync(process.execPath, ['--import', shim, selector, 'ws://synthetic', '/synthetic/work', scenario.startsWith('explicit') ? 'explicit-thread' : ''], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, KA_CODEX_THREAD_OWNER_FILE: owner, KA_CODEX_MODEL: 'synthetic-model', TEST_JOURNAL: journal, TEST_SCENARIO: scenario, KA_CODEX_THREAD_RESUME_TIMEOUT_MS: '100', TEST_WRONG: scenario === 'wrong-cwd' ? '1' : '' },
      })
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse)
      if (['wrong-cwd','explicit-missing','owner-timeout','owner-other-error'].includes(scenario)) {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /another workspace|no rollout found|timed out|internal storage failure/)
        assert.equal(requests.some(r => r.method === 'thread/list'), false)
        assert.equal(requests.some(r => r.method === 'thread/resume'), false)
      } else {
        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        if (scenario === 'fresh' || scenario === 'missing-fresh') assert.equal(output.fresh, true)
        else if (['missing-latest','resume-missing'].includes(scenario)) {
          assert.equal(output.id, 'latest-thread')
          assert.deepEqual(requests.find(r => r.method === 'thread/list').params, { cwd: '/synthetic/work', limit: 1, sortKey: 'recency_at', sortDirection: 'desc' })
          assert.equal(requests.filter(r => r.method === 'thread/resume').at(-1).params.model, 'synthetic-model')
        }
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
