import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWorkshopCodexTargets } from '../../channels/core/src/workshop-targets.ts'

test('discovers codex mates from the shared workshop schema', () => {
  assert.deepEqual(normalizeWorkshopCodexTargets({
    runtime: 'cc',
    mates: [
      { name: 'Main', cwd: '~/main', main: true },
      { name: 'Codex.Reviewer', cwd: '~/review', runtime: 'codex' },
      { name: 'helper', cwd: '/srv/helper', runtime: 'cc' },
    ],
  }, '/home/test'), [{ name: 'codexreviewer', cwd: '/home/test/review' }])
})

test('applies the top-level runtime default and ignores malformed or duplicate mates', () => {
  assert.deepEqual(normalizeWorkshopCodexTargets({
    runtime: 'codex',
    mates: [
      { name: 'Main', cwd: '/srv/main' },
      { name: 'main', cwd: '/srv/duplicate' },
      { name: 'cc-only', cwd: '/srv/cc', runtime: 'cc' },
      { name: 'missing-cwd' },
    ],
  }), [{ name: 'main', cwd: '/srv/main' }])
})

test('returns no targets when workshop configuration is absent', () => {
  assert.deepEqual(normalizeWorkshopCodexTargets(undefined), [])
  assert.deepEqual(normalizeWorkshopCodexTargets({ mates: [] }), [])
})
