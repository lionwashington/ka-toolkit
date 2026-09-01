import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

const roots = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

function runHook(hook, input, env) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(process.execPath, [hook], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({
      code,
      signal,
      stdout,
      stderr,
      elapsedMs: performance.now() - started,
    }))
    child.stdin.end(JSON.stringify(input))
  })
}

test('built Stop hook incrementally captures a tail turn and emits JSON stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-codex-hook-e2e-'))
  roots.push(root)
  const configDir = join(root, 'config')
  const kbDir = join(root, 'kb')
  const stateDir = join(root, 'state')
  const rawDir = join(kbDir, 'raw')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  for (let i = 0; i < 1_500; i++) {
    writeFileSync(join(rawDir, `2026-01-01-unrelated-${i}.md`), '---\nsession_id: unrelated\n---\n')
  }
  writeFileSync(join(configDir, 'config.yaml'), [
    `knowledge_base_path: ${JSON.stringify(kbDir)}`,
    `state_dir: ${JSON.stringify(stateDir)}`,
    'channels:',
    '  capture:',
    '    - main',
    '',
  ].join('\n'))

  const rollout = join(root, 'rollout.jsonl')
  writeFileSync(rollout, '')
  truncateSync(rollout, 96 * 1024 * 1024)
  const records = [
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'e2e-turn' } },
    { timestamp: '2026-09-01T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic E2E question' } },
    { timestamp: '2026-09-01T00:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic E2E answer' } },
  ]
  appendFileSync(rollout, `\n${records.map(record => JSON.stringify(record)).join('\n')}\n`)

  const here = dirname(fileURLToPath(import.meta.url))
  const hook = join(here, '..', 'dist', 'hooks', 'capture-hook.js')
  const result = await runHook(hook, {
    session_id: 'synthetic-session',
    turn_id: 'e2e-turn',
    transcript_path: rollout,
    cwd: '/synthetic/workspace',
    hook_event_name: 'Stop',
  }, { KA_HOME: root, KA_CHANNEL: 'main' })

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  assert.deepEqual(JSON.parse(result.stdout), {})
  assert.ok(result.elapsedMs < 3_000, `hook took ${result.elapsedMs.toFixed(0)}ms`)
  const files = readdirSync(rawDir)
  assert.equal(files.length, 1_501, `stderr: ${result.stderr}`)
  const captured = files.find(file => !file.includes('unrelated'))
  assert.ok(captured)
  const saved = readFileSync(join(rawDir, captured), 'utf8')
  assert.match(saved, /Synthetic E2E question/)
  assert.match(saved, /Synthetic E2E answer/)
  const read = Number(saved.match(/rollout_bytes_read:\s*(\d+)/)?.[1])
  assert.ok(read > 0 && read < 256 * 1024, `unexpected bytes read: ${read}`)
})
