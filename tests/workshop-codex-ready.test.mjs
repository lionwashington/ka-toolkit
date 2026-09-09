import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const adapter = fileURLToPath(new URL('../workshop/ops/runtimes/codex/ready-signals.sh', import.meta.url))
const matches = content => spawnSync('bash', ['-c', 'source "$1"; runtime::ready_match "$2"', 'test', adapter, content], { encoding: 'utf8' })

test('Codex idle prompt and status are ready', () => {
  for (const content of ['header\n  ›  \n? for shortcuts', '100% context left', 'Ask Codex']) {
    assert.equal(matches(content).status, 0)
  }
})

test('hook review blocks readiness even with prompt/status visible behind it', () => {
  for (const content of [
    'Hooks need review\n1 hook is new or changed\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting',
    'Hooks need review\n  ›  \n? for shortcuts',
    '2. Trust all and continue\n100% context left',
    '3. Continue without trusting\nAsk Codex',
    'Starting Codex...',
  ]) assert.equal(matches(content).status, 1, content)
})
