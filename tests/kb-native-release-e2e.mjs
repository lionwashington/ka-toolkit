// Explicit, opt-in canary: disk-backed scratch space, real native install, no model download.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const repo = fileURLToPath(new URL('..', import.meta.url))
const requireSdk = createRequire(new URL('../kb/mcp-server/package.json', import.meta.url))

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }, 480_000)
  try { const [status] = await once(child, 'exit'); assert.equal(status, 0, output.slice(-3000)); return output }
  finally { clearTimeout(timer) }
}

test('real KB native closure, published FTS5 daemon and four MCP tools', { skip: process.env.KA_RUN_NATIVE_INSTALL !== '1', timeout: 600_000 }, async () => {
  const root = mkdtempSync('/var/tmp/ka-kb-canary-')
  const runtime = join(root, 'runtime'), state = join(root, 'state'), knowledge = join(root, 'knowledge')
  for (const path of [state, join(runtime, 'config'), join(root, 'tmp'), join(knowledge, 'topics')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(knowledge, 'topics', 'synthetic.md'), '---\ntitle: synthetic\ndescription: Synthetic canary topic\n---\n# Synthetic\n\ncanaryneedle deterministic fixture\n')
  const env = { ...process.env, KA_HOME: runtime, KA_CONFIG_DIR: join(runtime, 'config'), KA_STATE_DIR: state,
    KA_EMBED_CACHE_DIR: join(root, 'model-cache'), npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: '/dev/null',
    ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip', TMPDIR: join(root, 'tmp'), NODE_OPTIONS: '--max-old-space-size=384', TEST_REPO: repo }
  let daemon, client
  try {
    // Execute the actual deploy function, excluding unrelated components and all switch steps.
    const source = readFileSync(join(repo, 'install.sh'), 'utf8').replace(/\nmain\s*$/, '\n')
    const script = join(root, 'install-kb.sh')
    writeFileSync(script, source + '\nREPO_ROOT="$TEST_REPO"\ndeploy_kb_mcp\n[ "$INSTALL_FAILURES" -eq 0 ]\n')
    await run('bash', [script, '--only', 'node-mcp'], { cwd: repo, env })
    const component = join(runtime, 'kb', 'mcp', 'kb')
    const release = realpathSync(join(component, 'current'))
    // Real LanceDB write/query and a tiny synthetic ONNX Identity model, CPU only.
    const smoke = `
import assert from 'node:assert/strict';
import * as lance from '@lancedb/lancedb';
import * as ort from 'onnxruntime-node';
import * as fastembed from 'fastembed';
assert.ok(Object.keys(fastembed).length);
const db=await lance.connect(process.env.TEST_DB);
const table=await db.createTable('synthetic',[{id:1,vector:[1,0]}]);
assert.equal(await table.countRows(),1);
assert.equal((await table.vectorSearch([1,0]).limit(1).toArray())[0].id,1);
const v=n=>{const a=[];do{a.push((n&127)|(n>127?128:0));n>>>=7}while(n);return Buffer.from(a)};
const b=(n,x)=>{x=typeof x==='string'?Buffer.from(x):x;return Buffer.concat([v(n*8+2),v(x.length),x])};
const i=(n,x)=>Buffer.concat([v(n*8),v(x)]);
const c=(...x)=>Buffer.concat(x);
const value=name=>c(b(1,name),b(2,b(1,c(i(1,1),b(2,b(1,i(1,1)))))));
const graph=c(b(1,c(b(1,'x'),b(2,'y'),b(4,'Identity'))),b(2,'synthetic'),b(11,value('x')),b(12,value('y')));
const model=c(i(1,7),b(2,'synthetic'),b(7,graph),b(8,i(2,13)));
const session=await ort.InferenceSession.create(model,{executionProviders:['cpu'],intraOpNumThreads:1,interOpNumThreads:1});
const result=await session.run({x:new ort.Tensor('float32',Float32Array.of(2),[1])});
assert.equal(result.y.data[0],2); await session.release();
console.log('native-closure-ok');
`
    await run(process.execPath, ['--input-type=module', '-e', smoke], { cwd: release, env: { ...env, TEST_DB: join(root, 'native-db') } })
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve))
    const config = join(runtime, 'config', 'config.yaml')
    writeFileSync(config, `knowledge_base_path: ${knowledge}\nstate_dir: ${state}\nretrieval:\n  mode: fts5\n  daemon:\n    host: 127.0.0.1\n    port: ${port}\n`)
    // Use the compatibility entry so its direct-entry guard is exercised too.
    daemon = spawn(process.execPath, [join(component, 'dist', 'daemon.mjs'), config], { env, stdio: 'ignore' })
    let ready = false
    for (let n = 0; n < 150; n++) {
      assert.equal(daemon.exitCode, null, 'canary daemon exited')
      try { const status = await fetch(`http://127.0.0.1:${port}/api/status`).then(r => r.json()); if (status.ready) { ready = true; break } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, 'isolated daemon must become ready')
    const { Client } = await import(requireSdk.resolve('@modelcontextprotocol/sdk/client/index.js'))
    const { StreamableHTTPClientTransport } = await import(requireSdk.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
    client = new Client({ name: 'synthetic-canary', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    for (const [name, args, pattern] of [
      ['kb_status', {}, /fts5/i], ['kb_list_topics', {}, /synthetic/],
      ['kb_search', { query: 'canaryneedle', max_results: 1 }, /canaryneedle/],
      ['kb_read_topic', { topic: 'synthetic', force: true }, /canaryneedle/],
    ]) {
      const result = await client.callTool({ name, arguments: args })
      assert.notEqual(result.isError, true, name)
      assert.match(JSON.stringify(result.content), pattern, name)
    }
    await run('python3', [join(repo, 'shared/ops/component-release.py'), 'verify', component, release.split('/').at(-1)], { env })
    console.log('PASS: real native install; LanceDB vector query; ONNX CPU inference; published FTS5 daemon; four MCP calls; release integrity')
  } finally {
    await client?.close()
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit')
      const deadline = setTimeout(() => daemon.kill('SIGKILL'), 5000)
      daemon.kill('SIGTERM'); await exited; clearTimeout(deadline)
    }
    rmSync(root, { recursive: true, force: true })
  }
})
