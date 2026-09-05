import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'

const helper = fileURLToPath(new URL('../shared/ops/component-release.py', import.meta.url))
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ka-component-test-'))
  const dest = join(root, 'component')
  const run = (...args) => spawnSync('python3', [helper, args[0], dest, ...args.slice(1)], { encoding: 'utf8' })
  const stage = version => {
    const dir = run('begin').stdout.trim()
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'version.mjs'), `export default ${JSON.stringify(version)}`)
    writeFileSync(join(dir, 'daemon.mjs'), "if(process.env.TEST_WAIT) { console.log('ready'); await new Promise(r=>setTimeout(r,1500)); } const {default:v}=await import('./lib/version.mjs'); console.log(JSON.stringify({version:v,data:process.env.KA_DAEMON_DATA_DIR}));")
    writeFileSync(join(dir, 'start.sh'), '#!/bin/bash\nprintf "%s\\n" "$KA_COMPONENT_ROOT"\n')
    return dir
  }
  return { root, dest, run, stage }
}

test('component publication, pinning, rollback and corruption rejection preserve mutable data', async () => {
  const { root, dest, run, stage } = harness()
  try {
    const one = run('publish', stage('one'))
    assert.equal(one.status, 0, one.stderr)
    const first = JSON.parse(one.stdout).release
    writeFileSync(join(dest, 'state.json'), 'synthetic mutable data')
    mkdirSync(join(dest, 'attachments')); writeFileSync(join(dest, 'attachments', 'synthetic.bin'), 'bytes')
    const child = spawn(process.execPath, [join(dest, 'daemon.mjs')], { env: { ...process.env, TEST_WAIT: '1' } })
    let output = ''; child.stdout.on('data', d => { output += d })
    await once(child.stdout, 'data')
    assert.equal(run('publish', stage('two')).status, 0)
    await once(child, 'exit')
    assert.equal(JSON.parse(output.trim().split('\n').at(-1)).version, 'one', 'a running import stays pinned to its release')
    const latest = () => JSON.parse(spawnSync(process.execPath, [join(dest, 'daemon.mjs')], { encoding: 'utf8' }).stdout)
    assert.equal(latest().version, 'two')
    assert.equal(latest().data.replace(/\/$/, ''), dest)
    assert.equal(spawnSync('bash', [join(dest, 'start.sh')], { encoding: 'utf8' }).stdout.trim(), dest)
    assert.equal(run('rollback', first).status, 0)
    assert.equal(latest().version, 'one')
    const oldPointer = readlinkSync(join(dest, 'current'))
    const broken = stage('broken'); writeFileSync(join(broken, 'daemon.mjs'), 'export const = invalid')
    assert.notEqual(run('publish', broken).status, 0)
    assert.equal(readlinkSync(join(dest, 'current')), oldPointer)
    assert.equal(readFileSync(join(dest, 'state.json'), 'utf8'), 'synthetic mutable data')
    assert.equal(readFileSync(join(dest, 'attachments', 'synthetic.bin'), 'utf8'), 'bytes')
    writeFileSync(join(dest, oldPointer, 'lib', 'version.mjs'), 'export default "tampered"')
    assert.notEqual(run('verify', first).status, 0)
    assert.notEqual(run('rollback', first).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy layout and escaping staging dependencies fail closed', () => {
  const { root, dest, run, stage } = harness()
  try {
    const dir = stage('one')
    writeFileSync(join(dest, 'daemon.mjs'), 'export const legacy = true')
    assert.notEqual(run('publish', dir).status, 0)
    assert.equal(readFileSync(join(dest, 'daemon.mjs'), 'utf8'), 'export const legacy = true')
    assert.equal(run('publish', dir, '--bootstrap').status, 0)
    const bad = stage('bad'); symlinkSync(root, join(bad, 'external'))
    assert.notEqual(run('publish', bad).status, 0)
    assert.notEqual(run('rollback', '../escape').status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('stdio-style entry guards see the pinned entry, not the compatibility wrapper', () => {
  const { root, dest, run, stage } = harness()
  try {
    const dir = stage('guard')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.mjs'), "import {pathToFileURL} from 'node:url'; if(import.meta.url===pathToFileURL(process.argv[1]).href) console.log('guard-ran');")
    assert.equal(run('publish', dir).status, 0)
    const result = spawnSync(process.execPath, [join(dest, 'dist', 'index.mjs')], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'guard-ran')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
