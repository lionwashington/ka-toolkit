import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { hookTrustOverride, discoverHookTrustOverride } from '../workshop/ops/runtimes/codex/hook-trust-overrides.mjs'

const cwd = '/synthetic/work'
const hook = { key: '/synthetic/.codex/config.toml:pre_tool_use:0:0', currentHash: 'hash-1', enabled: true, isManaged: false, trustStatus: 'untrusted' }
const response = hooks => ({ data: [{ cwd, hooks, errors: [], warnings: [] }] })

test('invocation overlay contains only exact enabled untrusted/modified identities', () => {
  const result = hookTrustOverride(response([
    hook, { ...hook, key: 'changed', currentHash: 'new-hash', trustStatus: 'modified' },
    { ...hook, key: 'disabled', enabled: false }, { ...hook, key: 'managed', isManaged: true },
    { ...hook, key: 'trusted', trustStatus: 'trusted' },
  ]), cwd)
  assert.equal(result, 'hooks.state={"/synthetic/.codex/config.toml:pre_tool_use:0:0"={trusted_hash="hash-1"},"changed"={trusted_hash="new-hash"}}')
  assert.equal(result.includes('enabled'), false)
  assert.equal(result.includes('command'), false)
})

test('unchanged trusted/disabled or absent hooks need no overlay', () => {
  assert.equal(hookTrustOverride(response([]), cwd), '')
  assert.equal(hookTrustOverride(response([{ ...hook, enabled: false }, { ...hook, trustStatus: 'trusted' }]), cwd), '')
})

test('malformed, conflicting, wrong-workspace discovery fails closed', () => {
  for (const invalid of [null, { data: [] }, response([{ ...hook, currentHash: null }]),
    response([{ ...hook, key: 'bad\nkey' }]), response([{ ...hook, trustStatus: 'unknown' }]),
    response([hook, { ...hook, currentHash: 'other' }]),
    { data: [{ cwd, hooks: [], errors: ['synthetic-sensitive-error'] }] },
  ]) assert.throws(() => hookTrustOverride(invalid, cwd))
  assert.throws(() => hookTrustOverride(response([hook]), '/other'))
})

for (const scenario of ['success', 'rpc-error', 'malformed', 'timeout', 'exit']) {
  test(`isolated probe: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ka-hook-trust-test-'))
    const script = join(root, 'fake-codex.mjs')
    const journal = join(root, 'requests.jsonl')
    writeFileSync(script, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const scenario=${JSON.stringify(scenario)};
createInterface({input:process.stdin}).on('line', line=>{
 appendFileSync(${JSON.stringify(journal)}, line+'\\n');
 const req=JSON.parse(line);
 if (!req.id) return;
 if (scenario==='timeout') return;
 if (scenario==='exit') process.exit(3);
 if (scenario==='malformed') { console.log('not-json'); return; }
 console.log(JSON.stringify(scenario==='rpc-error' ? {id:req.id,error:{message:'synthetic-secret'}} :
 {id:req.id,result:req.method==='initialize'?{}:${JSON.stringify(response([hook]))}}));
});`)
    let spawned
    try {
      const run = discoverHookTrustOverride(cwd, ['-c', 'model="synthetic"'], {
        timeoutMs: 300,
        spawnProcess(command, args, options) {
          assert.equal(command, 'codex')
          assert.deepEqual(args, ['-c', 'model="synthetic"', 'app-server', '--stdio'])
          assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
          assert.equal(options.detached, process.platform !== 'win32')
          spawned = spawn(process.execPath, [script], { ...options, cwd: root })
          return spawned
        },
      })
      if (scenario === 'success') {
        assert.equal(await run, hookTrustOverride(response([hook]), cwd))
        const requests = readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse)
        assert.deepEqual(requests.map(req => req.method), ['initialize', 'initialized', 'hooks/list'])
        assert.deepEqual(requests.at(-1).params, { cwds: [cwd] })
      } else {
        await assert.rejects(run, error => !error.message.includes('synthetic-secret'))
      }
      assert.ok(spawned.exitCode !== null || spawned.signalCode !== null)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('probe cleans up a TERM-ignoring grandchild which inherits its pipes', { skip: process.platform !== 'linux', timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-hook-trust-descendant-'))
  const script = join(root, 'fake-codex.mjs')
  const descendantPidFile = join(root, 'descendant.pid')
  writeFileSync(script, `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore','inherit','inherit','ipc'] });
writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
const ready = new Promise(resolve => descendant.once('message',resolve));
createInterface({input:process.stdin}).on('line', async line => {
 const req=JSON.parse(line);
 if (!req.id) return;
 await ready;
 console.log(JSON.stringify({id:req.id,result:req.method==='initialize'?{}:${JSON.stringify(response([hook]))}}));
});`)
  let spawned
  let descendantPid
  try {
    const result = await discoverHookTrustOverride(cwd, [], {
      timeoutMs: 1000,
      spawnProcess(_command, _args, options) {
        spawned = spawn(process.execPath, [script], { ...options, cwd: root })
        return spawned
      },
    })
    assert.equal(result, hookTrustOverride(response([hook]), cwd))
    descendantPid = Number(readFileSync(descendantPidFile, 'utf8'))
    assert.equal(spawned.stdout.destroyed, true)
    assert.equal(spawned.stderr.destroyed, true)
    // A killed orphan may briefly remain a zombie until PID 1 reaps it.
    let state = ''
    for (let attempt = 0; attempt < 50; attempt++) {
      try { state = readFileSync(`/proc/${descendantPid}/stat`, 'utf8').split(') ')[1][0] }
      catch (error) { if (error.code === 'ENOENT') { state = 'gone'; break }; throw error }
      if (state === 'Z') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(state === 'gone' || state === 'Z', 'probe descendant must not remain running')
  } finally {
    // Also clean up the old implementation when this regression test fails.
    if (spawned?.pid) { try { process.kill(-spawned.pid, 'SIGKILL') } catch {} }
    spawned?.stdout.destroy()
    spawned?.stderr.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancelling the probe owner cleans up its detached child and restores signal listeners', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-hook-trust-cancel-'))
  const script = join(root, 'owner.mjs')
  const helperUrl = new URL('../workshop/ops/runtimes/codex/hook-trust-overrides.mjs', import.meta.url).href
  writeFileSync(script, `
import { spawn } from 'node:child_process';
import { discoverHookTrustOverride } from ${JSON.stringify(helperUrl)};
const signals = ['SIGTERM','SIGINT','SIGHUP'];
const counts = signals.map(signal => process.listenerCount(signal));
try {
 await discoverHookTrustOverride(${JSON.stringify(root)}, [], { timeoutMs:10000, spawnProcess(_cmd,_args,options) {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);
  child.once('spawn',()=>console.log(JSON.stringify({ready:true,pid:child.pid})));
  return child;
 }});
 process.exitCode=2;
} catch(error) {
 console.log(JSON.stringify({cancelled:error.message==='Codex hook discovery cancelled',listenersRestored:signals.every((signal,index)=>process.listenerCount(signal)===counts[index])}));
}
`)
  const owner = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  owner.stdout.on('data', chunk => { output += chunk })
  let childPid
  try {
    const exited = once(owner, 'exit')
    while (!output.includes('\n')) await once(owner.stdout, 'data')
    childPid = JSON.parse(output.split('\n')[0]).pid
    owner.kill('SIGTERM')
    const [code, signal] = await exited
    assert.equal(code, 0)
    assert.equal(signal, null)
    const result = JSON.parse(output.trim().split('\n').at(-1))
    assert.equal(result.cancelled, true)
    assert.equal(result.listenersRestored, true)
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
  } finally {
    if (owner.exitCode === null) owner.kill('SIGKILL')
    if (childPid) { try { process.kill(-childPid, 'SIGKILL') } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
})
