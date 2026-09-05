import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const cli = fileURLToPath(new URL('../kb/core/dist/capture-snapshot-cli.js', import.meta.url))
const core = new URL('../kb/core/dist/index.js', import.meta.url).href
const hook = new URL('../kb/adapter-codex/dist/hooks/capture-hook.js', import.meta.url).href

test('actual Codex capture racing a separate acknowledgement preserves the continuation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-hook-ack-race-'))
  try {
    const rawDir = join(root, 'raw'), rollout = join(root, 'rollout.jsonl'), job = join(root, 'job.json')
    const records = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'synthetic-turn' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic question' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'synthetic answer' } },
    ]
    writeFileSync(rollout, records.map(r => JSON.stringify(r)).join('\n') + '\n')
    const input = { session_id: 'synthetic-session', turn_id: 'synthetic-turn', transcript_path: rollout, cwd: root, hook_event_name: 'Stop' }
    const code = `import {handleCodexStopEvent} from ${JSON.stringify(hook)}; await handleCodexStopEvent(${JSON.stringify(input)}, ${JSON.stringify(rawDir)});`
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code]).status, 0)
    const file = readdirSync(rawDir).find(f => f.endsWith('.md'))
    assert.equal(spawnSync(process.execPath, [cli, 'snapshot', '--raw-dir', rawDir, '--file', file, '--job', job]).status, 0)
    appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'synthetic continuation' } }) + '\n')
    await Promise.all([
      ['--input-type=module', '-e', code],
      [cli, 'ack', '--job', job, '--topics-json', '["synthetic"]'],
    ].map(async args => {
      const child = spawn(process.execPath, args, { stdio: 'pipe' })
      const [status] = await once(child, 'exit'); assert.equal(status, 0)
    }))
    const { parseFrontmatter } = await import(core)
    const result = parseFrontmatter(readFileSync(join(rawDir, file), 'utf8'))
    assert.equal(result.data.distilled, false)
    assert.equal(result.data.distilled_message_count, 2)
    assert.match(result.content, /synthetic continuation/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('durable snapshot CLI: continuation, repeated ack, symlink discovery and source isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-capture-job-'))
  try {
    const rawDir = join(root, 'raw'); mkdirSync(rawDir)
    const file = join(rawDir, 'synthetic.md'), job = join(root, 'jobs', 'one.json')
    const header = '---\nid: synthetic\nsource: codex\ndistilled: false\n---\n'
    writeFileSync(file, header + '## User\n\nfirst\n')
    const link = join(root, 'discovery.js'); symlinkSync(cli, link)
    const run = (...args) => spawnSync(process.execPath, [link, ...args], { encoding: 'utf8' })
    const snapshot = run('snapshot', '--raw-dir', rawDir, '--file', 'synthetic.md', '--job', job)
    assert.equal(snapshot.status, 0, snapshot.stderr)
    assert.match(JSON.parse(snapshot.stdout).text, /first/)
    assert.equal(statSync(job).mode & 0o777, 0o600)
    assert.notEqual(run('snapshot', '--raw-dir', rawDir, '--file', 'synthetic.md', '--job', job).status, 0)
    writeFileSync(file, header + '## User\n\nfirst\n\n## Assistant\n\nsecond\n')
    const ack = () => run('ack', '--job', job, '--topics-json', '["synthetic"]')
    assert.equal(JSON.parse(ack().stdout).status, 'acknowledged')
    assert.equal(JSON.parse(ack().stdout).complete, false)
    assert.match(readFileSync(file, 'utf8'), /distilled: false/)
    assert.match(readFileSync(file, 'utf8'), /second/)
    const before = statSync(file).mtimeMs
    assert.equal(JSON.parse(ack().stdout).status, 'unchanged')
    assert.equal(statSync(file).mtimeMs, before)
    const next = run('snapshot', '--raw-dir', rawDir, '--file', 'synthetic.md', '--job', join(root, 'two.json'))
    assert.doesNotMatch(JSON.parse(next.stdout).text, /first/)
    assert.match(JSON.parse(next.stdout).text, /second/)
    assert.equal(JSON.parse(run('ack', '--job', join(root, 'two.json'), '--topics-json', '["synthetic"]').stdout).complete, true)
    writeFileSync(file, header + '## User\n\ncorrected\n')
    assert.equal(ack().status, 3)
    assert.match(readFileSync(file, 'utf8'), /corrected/)
    writeFileSync(file, header.replace('source: codex', 'source: claude-code') + '## User\n\nprivate-synthetic-text\n')
    const wrong = run('snapshot', '--raw-dir', rawDir, '--file', 'synthetic.md', '--job', join(root, 'wrong.json'))
    assert.equal(wrong.status, 1)
    assert.doesNotMatch(wrong.stderr + wrong.stdout, /private-synthetic-text/)
    assert.notEqual(run('snapshot', '--raw-dir', rawDir, '--file', '../escape.md', '--job', job).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cross-process CAS loses no updates and OS releases a crashed writer lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-capture-concurrent-'))
  try {
    const file = join(root, 'counter'); writeFileSync(file, '0')
    const code = `import {atomicUpdateText} from ${JSON.stringify(core)}; atomicUpdateText(process.argv[1], old => String(Number(old) + 1));`
    await Promise.all(Array.from({ length: 6 }, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { stdio: 'pipe' })
      const [status] = await once(child, 'exit'); assert.equal(status, 0)
    }))
    assert.equal(readFileSync(file, 'utf8'), '6')
    const holder = spawn('python3', ['-u', '-c', 'import fcntl,sys,time; f=open(sys.argv[1]+".lock","a"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(30)', file])
    await once(holder.stdout, 'data')
    holder.kill('SIGKILL'); await once(holder, 'exit')
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code, file]).status, 0)
    assert.equal(readFileSync(file, 'utf8'), '7')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
