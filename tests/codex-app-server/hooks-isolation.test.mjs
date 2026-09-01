import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  configureClaudeHooks,
  configureCodexHooks,
} from '../../scripts/configure-runtime-hooks.mjs'

const roots = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

function fixture() {
  return {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node /legacy/kb/hooks/capture-hook.js', timeout: 10000 }] },
        { hooks: [{ type: 'command', command: 'python3 /legacy/channels/ops/reply-safety-hook.py', timeout: 10000 }] },
        { hooks: [{ type: 'command', command: 'node /legacy/kb/hooks/codex-capture-hook.js', timeout: 30 }] },
        { matcher: 'keep', hooks: [{ type: 'command', command: 'node /third-party/stop.js', timeout: 7 }] },
      ],
    },
  }
}

function commands(data) {
  return data.hooks.Stop.flatMap(group => group.hooks ?? []).map(hook => hook.command)
}

test('Codex receives only its capture hook and preserves unrelated hooks', () => {
  const configured = configureCodexHooks(fixture(), '/runtime/kb/hooks/codex-capture-hook.js')
  const result = commands(configured)
  assert.deepEqual(result, [
    'node /third-party/stop.js',
    "node '/runtime/kb/hooks/codex-capture-hook.js'",
  ])
  assert.equal(JSON.stringify(configured).includes('reply-safety-hook.py'), false)
  assert.equal(JSON.stringify(configured).includes('/capture-hook.js'), false)
  assert.equal(configured.hooks.Stop.at(-1).hooks[0].timeout, 10)
})

test('Claude receives only Claude capture and reply safety hooks', () => {
  const configured = configureClaudeHooks(
    fixture(),
    '/runtime/kb/hooks/capture-hook.js',
    '/runtime/channels/ops/reply-safety-hook.py',
  )
  const result = commands(configured)
  assert.deepEqual(result, [
    'node /third-party/stop.js',
    "node '/runtime/kb/hooks/capture-hook.js'",
    "python3 '/runtime/channels/ops/reply-safety-hook.py'",
  ])
  assert.equal(JSON.stringify(configured).includes('codex-capture-hook.js'), false)
})

test('CLI atomically rewrites a Codex config and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-hook-isolation-'))
  roots.push(root)
  const config = join(root, 'hooks.json')
  writeFileSync(config, JSON.stringify(fixture()))
  const script = fileURLToPath(new URL('../../scripts/configure-runtime-hooks.mjs', import.meta.url))
  for (let i = 0; i < 2; i++) {
    const run = spawnSync(process.execPath, [script, 'codex', config, '/runtime/codex-capture-hook.js'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  }
  const data = JSON.parse(readFileSync(config, 'utf8'))
  assert.deepEqual(commands(data), ['node /third-party/stop.js', "node '/runtime/codex-capture-hook.js'"])
})

test('isolated hooks install deploys matching code and keeps runtimes separated', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-hooks-install-e2e-'))
  roots.push(root)
  const runtime = join(root, 'runtime')
  const claudeSettings = join(root, 'claude', 'settings.json')
  const codexHooks = join(root, 'codex', 'hooks.json')
  mkdirSync(join(root, 'claude'), { recursive: true })
  mkdirSync(join(root, 'codex'), { recursive: true })
  writeFileSync(claudeSettings, JSON.stringify(fixture()))
  writeFileSync(codexHooks, JSON.stringify(fixture()))
  const repo = fileURLToPath(new URL('../..', import.meta.url))
  const run = spawnSync(join(repo, 'install.sh'), ['--only', 'hooks', '--switch'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      KA_HOME: runtime,
      KA_CLAUDE_SETTINGS: claudeSettings,
      KA_CODEX_HOOKS: codexHooks,
    },
  })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  assert.ok(existsSync(join(runtime, 'kb', 'hooks', 'capture-hook.js')))
  assert.ok(existsSync(join(runtime, 'kb', 'hooks', 'codex-capture-hook.js')))
  assert.ok(existsSync(join(runtime, 'channels', 'ops', 'reply-safety-hook.py')))
  const codex = readFileSync(codexHooks, 'utf8')
  const claude = readFileSync(claudeSettings, 'utf8')
  assert.match(codex, /codex-capture-hook\.js/)
  assert.doesNotMatch(codex, /reply-safety-hook\.py|(?<!codex-)capture-hook\.js/)
  assert.match(claude, /reply-safety-hook\.py/)
  assert.match(claude, /(?<!codex-)capture-hook\.js/)
  assert.doesNotMatch(claude, /codex-capture-hook\.js/)
})
