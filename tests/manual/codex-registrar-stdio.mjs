#!/usr/bin/env node
// Opt-in full-launcher regression with an isolated Codex home, tmux socket and
// loopback mock model. No real credentials, business threads or production Channel.
// Tests registrar stdio and remote-resume compatibility; hook trust is separate.
// Requires Linux, Codex 0.153.x/0.154.x, Node >=22, Python, tmux and stty.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

for (const command of ['codex', 'tmux', 'stty']) {
  if (spawnSync(command, ['--version'], { stdio: 'ignore' }).error) throw new Error(`required test executable missing: ${command}`)
}
const root = mkdtempSync(join(tmpdir(), 'ka-codex-remote-startup-'))
const cwd = join(root, 'work')
mkdirSync(cwd)
const env = { PATH: process.env.PATH, CODEX_HOME: root, TERM: 'xterm-256color', LANG: 'C.UTF-8' }
const delay = ms => new Promise(done => setTimeout(done, ms))
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
let modelRequests = 0
const modelServer = createHttpServer((request, response) => {
  request.resume()
  modelRequests += 1
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const item = { id: 'fixture_message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ISOLATED_PROBE_OK' }] }
  for (const event of [
    { type: 'response.created', response: { id: 'fixture_response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture_response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
})
await new Promise(done => modelServer.listen(0, '127.0.0.1', done))
const config = `model="probe"\nmodel_provider="probe"\n[model_providers.probe]\nname="probe"\nbase_url="http://127.0.0.1:${modelServer.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`
writeFileSync(join(root, 'config.toml'), config)

async function runScenario(name) {
  const originalConfig = readFileSync(join(root, 'config.toml'), 'utf8')
  const args = []
  const listener = createTcpServer()
  await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const endpoint = `ws://127.0.0.1:${listener.address().port}`
  await new Promise(done => listener.close(done))
  const sidecar = spawn('codex', [...args, '--dangerously-bypass-hook-trust', 'app-server', '--listen', endpoint], {
    cwd, env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  sidecar.stderr.resume()
  const socket = `ka-isolated-startup-${process.pid}-${name}`
  const tmux = (...argv) => spawnSync('tmux', ['-L', socket, ...argv], { env, encoding: 'utf8', timeout: 5000 })
  const capture = () => tmux('capture-pane', '-p', '-t', 'fixture:0').stdout || ''
  let ws
  const pending = new Map()
  let nextId = 0
  let completed = false
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ws = new WebSocket(endpoint)
        await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
        break
      } catch { await delay(100) }
    }
    assert.equal(ws?.readyState, WebSocket.OPEN, 'isolated sidecar did not listen')
    ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.method === 'turn/completed') completed = true
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      clearTimeout(call.timer)
      message.error ? call.reject(new Error('isolated RPC request failed')) : call.done(message.result)
    }
    const rpc = (method, params) => new Promise((done, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`isolated RPC timed out: ${method}`)) }, 10_000)
      pending.set(id, { done, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
    await rpc('initialize', { clientInfo: { name: 'ka_isolated_tui_regression', version: '1' }, capabilities: { experimentalApi: true } })
    ws.send(JSON.stringify({ method: 'initialized', params: {} }))
    const thread = await rpc('thread/start', { cwd, model: 'probe', modelProvider: 'probe' })
    await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Isolated regression fixture. Reply OK.', text_elements: [] }] })
    for (let attempt = 0; attempt < 100 && !completed; attempt++) await delay(100)
    assert.ok(completed, 'local mock model turn did not persist')
    {
      ws.close()
      const stopped = new Promise(done => sidecar.once('exit', done))
      sidecar.kill('SIGTERM')
      await stopped
    }
    // Keep the isolated pane available on error, so a crashed TUI cannot be
    // mistaken for successful unattended startup merely because no menu remains.
    const launcher = fileURLToPath(new URL('../../workshop/ops/runtimes/codex/bin/start-pane.sh', import.meta.url))
    const actualLauncher = ['env', `KA_HOME=${fileURLToPath(new URL('../../', import.meta.url))}`, `KA_STATE_DIR=${join(root, 'state')}`, 'KA_CHANNEL=isolated-tty', 'KA_CHANNEL_KIND=telegram', 'KA_CHANNEL_PORT=1', 'KA_CODEX_KEEP_APP_SERVER_ON_TUI_EXIT=0', 'SHELL=/bin/bash', launcher, 'isolated-tty', cwd, 'resume', thread.thread.id]
    const trace = process.env.KA_TEST_STRACE ? [process.env.KA_TEST_STRACE, '-f', '-tt', '-yy', '-e', 'trace=ioctl,execve', '-o', `${process.env.KA_TEST_TRACE_PREFIX}-${name}.log`] : []
    const command = [...trace, ...actualLauncher].map(shellQuote).join(' ') + '; sleep 20'
    const created = tmux('new-session', '-d', '-s', 'fixture', '-x', '110', '-y', '35', '-c', cwd, command)
    assert.equal(created.status, 0, 'isolated tmux pane failed')
    // Startup draft briefly paints a composer before asynchronous hook review.
    // Do not treat that transient placeholder as completed TUI initialization.
    await delay(10000)
    let screen = ''
    for (let attempt = 0; attempt < 300; attempt++) {
      screen = capture()
      if (screen.includes('Hooks need review') || (screen.includes('Ask Codex to do anything') && screen.includes('ISOLATED_PROBE_OK'))) break
      await delay(100)
    }
    const tty = tmux('display-message', '-p', '-t', 'fixture:0', '#{pane_tty}').stdout.trim()
    const terminalMode = spawnSync('stty', ['-F', tty, '-a'], { encoding: 'utf8' }).stdout || ''
    const raw = terminalMode.includes('-icanon') && terminalMode.includes('-echo ') && terminalMode.includes('-icrnl')
    const hookPrompt = screen.includes('Hooks need review')
    const ready = screen.includes('Ask Codex to do anything') && screen.includes('ISOLATED_PROBE_OK')
    assert.ok(raw, `isolated TUI did not retain raw keyboard mode: ${screen}`)
    assert.equal(hookPrompt, false)
    let arrowEditing = false
    let enterStatus = false
    {
      assert.ok(ready, 'launcher did not reach a live composer')
      tmux('send-keys', '-t', 'fixture:0', '-l', 'KA_AB')
      tmux('send-keys', '-t', 'fixture:0', 'Left')
      tmux('send-keys', '-t', 'fixture:0', '-l', 'C')
      await delay(300)
      arrowEditing = capture().includes('KA_ACB')
      tmux('send-keys', '-t', 'fixture:0', 'End', 'C-u')
      tmux('send-keys', '-t', 'fixture:0', '-l', '/status')
      await delay(300)
      tmux('send-keys', '-t', 'fixture:0', 'Enter')
      await delay(700)
      enterStatus = /Session:/u.test(capture())
      assert.ok(arrowEditing, 'left arrow was not interpreted as an editing key')
      assert.ok(enterStatus, 'Enter did not execute local /status')
    }
    const configUnchanged = readFileSync(join(root, 'config.toml'), 'utf8') === originalConfig
    assert.ok(configUnchanged, 'test persisted hook trust unexpectedly')
    console.log(JSON.stringify({ scenario: name, hookPrompt, ready, raw, arrowEditing, enterStatus, configUnchanged }))
  } finally {
    tmux('kill-server')
    {
      const ownerFile = join(root, 'state/codex-app-servers/isolated-tty.instance.lock/pid')
      if (existsSync(ownerFile)) {
        const owner = Number(readFileSync(ownerFile, 'utf8').trim())
        // The fixture owns this exact launcher. Do not touch any production PID.
        try {
          const argv = readFileSync(`/proc/${owner}/cmdline`, 'utf8').split('\0')
          assert.ok(argv.includes('isolated-tty') && argv.includes(cwd))
          process.kill(owner, 'SIGTERM')
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
        for (let i = 0; i < 100 && existsSync(ownerFile); i++) await delay(100)
        assert.ok(!existsSync(ownerFile), 'fixture launcher cleanup timed out')
      }
    }
    ws?.close()
    for (const call of pending.values()) clearTimeout(call.timer)
    sidecar.kill('SIGTERM')
    if (sidecar.exitCode === null && sidecar.signalCode === null) {
      await Promise.race([new Promise(done => sidecar.once('exit', done)), delay(7000)])
      assert.ok(sidecar.exitCode !== null || sidecar.signalCode !== null, 'isolated sidecar cleanup timed out')
    }
  }
}

try {
  await runScenario('resume')
  await runScenario('second-launch')
  console.log(JSON.stringify({ passed: true, loopbackModelUsed: modelRequests >= 2 }))
} finally {
  modelServer.closeAllConnections()
  await new Promise(done => modelServer.close(done))
  rmSync(root, { recursive: true, force: true })
}
