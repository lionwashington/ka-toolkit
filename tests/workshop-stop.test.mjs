import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
const helper = fileURLToPath(new URL('../workshop/ops/runtimes/codex/stop-runtime.py', import.meta.url))
function run(args) {
  return new Promise(resolve => {
    const p = spawn('python3', [helper, ...args]); let out = ''
    p.stdout.on('data', b => out += b); p.stderr.on('data', b => out += b)
    p.on('close', code => resolve({ code, out }))
  })
}
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ka-stop-'))
  const lock = join(home, 'state/codex-app-servers/test-mate.instance.lock')
  mkdirSync(lock, { recursive: true })
  const thread = join(home, 'state/codex-app-servers/test-mate.thread'); writeFileSync(thread, 'saved-thread')
  const targets = new Set(['test-mate', 'sibling'])
  const server = createServer((req, res) => {
    if (req.method === 'DELETE') targets.delete(req.url.split('/').at(-1))
    res.end(JSON.stringify({ runtime_targets: [...targets].map(name => ({ name })) }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { home, lock, thread, targets, args: [home, 'test-mate', 'test-mate', String(server.address().port)],
    close: () => { server.close(); rmSync(home, { recursive: true, force: true }) } }
}
test('stops detached TERM-resistant group; preserves sibling, thread, and repeated stop', async () => {
  const f = await fixture(); const entry = join(f.home, 'workshop/ops/runtimes/codex/bin/start-pane.sh')
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, "#!/bin/bash\ntrap '' TERM HUP\nsleep 300 &\nwait\n")
  const p = spawn('/bin/bash', [entry, 'test-mate'], { detached: true, stdio: 'ignore' })
  const sentinel = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  try {
    writeFileSync(join(f.lock, 'pid'), String(p.pid)); await new Promise(r => setTimeout(r, 150))
    const result = await run(f.args); assert.equal(result.code, 0, result.out)
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0))
    assert.equal(readFileSync(f.thread, 'utf8'), 'saved-thread')
    assert.deepEqual([...f.targets], ['sibling'])
    assert.equal((await run(f.args)).code, 0)
  } finally {
    try { process.kill(-p.pid, 'SIGKILL') } catch {}
    try { process.kill(-sentinel.pid, 'SIGKILL') } catch {}
    f.close()
  }
})
test('unrelated owner PID fails closed', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.lock, 'pid'), String(process.pid))
    const result = await run(f.args); assert.equal(result.code, 1); assert.match(result.out, /identity mismatch/)
    assert.ok(f.targets.has('test-mate'))
  } finally { f.close() }
})
test('stale owner preserves canonical thread', async () => {
  const f = await fixture(); const p = spawn('true'); await new Promise(r => p.on('close', r))
  try {
    writeFileSync(join(f.lock, 'pid'), String(p.pid))
    const result = await run(f.args); assert.equal(result.code, 0, result.out)
    assert.equal(readFileSync(f.thread, 'utf8'), 'saved-thread')
  } finally { f.close() }
})

test('actual workshop stop/restart cleans pane-less owners and failure blocks restart; dry-run is inert', async () => {
  const { cpSync, existsSync } = await import('node:fs')
  const f = await fixture()
  const repo = fileURLToPath(new URL('..', import.meta.url))
  try {
    cpSync(join(repo, 'shared/ops'), join(f.home, 'shared/ops'), { recursive: true })
    cpSync(join(repo, 'workshop/ops'), join(f.home, 'workshop/ops'), { recursive: true })
    mkdirSync(join(f.home, 'config'), { recursive: true })
    writeFileSync(join(f.home, 'config/workshop.yaml'), 'session: isolated\nruntime: codex\nmates:\n  - name: test-mate\n    cwd: /synthetic/work\n')
    writeFileSync(join(f.home, 'config/config.yaml'), 'channel_kind: telegram\nchannels:\n  telegram:\n    port: ' + f.args[3] + '\n')
    const tmux = join(f.home, 'fake-tmux')
    const journal = join(f.home, 'tmux-journal')
    writeFileSync(tmux, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_JOURNAL"\ncase "$1" in has-session) exit 1;; esac\nexit 0\n', { mode: 0o755 })
    const invoke = (...args) => new Promise(resolve => {
      const p = spawn('/bin/bash', [join(f.home, 'workshop/ops/workshop.sh'), ...args], {
        env: { ...process.env, KA_HOME: f.home, OPS_CONFIG: join(f.home, 'config/workshop.yaml'), KA_CONFIG: join(f.home, 'config/config.yaml'), TMUX_BIN: tmux, TEST_JOURNAL: journal, TMUX: '', KA_CHANNEL_PORT: f.args[3], KA_STATE_DIR: join(f.home, 'state') },
      })
      let out = ''; p.stdout.on('data', b => out += b); p.stderr.on('data', b => out += b)
      p.on('close', code => resolve({ code, out }))
    })
    writeFileSync(join(f.lock, 'pid'), String(process.pid))
    let r = await invoke('stop', 'test-mate', '--dry-run')
    assert.equal(r.code, 0, r.out); assert.ok(existsSync(join(f.lock, 'pid')))
    r = await invoke('restart', 'test-mate')
    assert.notEqual(r.code, 0, r.out)
    assert.doesNotMatch(readFileSync(journal, 'utf8'), /new-session|split-window/)
    const stale = spawn('true'); await new Promise(r => stale.on('close', r))
    writeFileSync(join(f.lock, 'pid'), String(stale.pid))
    r = await invoke('stop', 'test-mate')
    assert.equal(r.code, 0, r.out); assert.match(r.out, /runtime and pane verified/)
    assert.equal(f.targets.has('test-mate'), false)
    writeFileSync(join(f.home, 'config/workshop.yaml'), 'session: isolated\nruntime: cc\nmates:\n  - name: test-mate\n    cwd: /synthetic/work\n')
    r = await invoke('stop', 'test-mate')
    assert.notEqual(r.code, 0); assert.match(r.out, /no session/)
    assert.doesNotMatch(r.out, /Codex runtime stopped/)
  } finally { f.close() }
})
