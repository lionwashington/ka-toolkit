import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'

const statePath = process.env.FAKE_CODEX_STATE
let state = { threads: {}, requests: [] }
try { if (statePath) state = JSON.parse(readFileSync(statePath, 'utf8')) } catch {}
state.requests ??= []

function save() { if (statePath) writeFileSync(statePath, JSON.stringify(state)) }
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }

let serverRequestId = 10_000
let turnId = 1
const pendingApprovals = new Map()
const activeTurns = new Map()

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.id !== undefined && !message.method) {
    const continuation = pendingApprovals.get(message.id)
    if (continuation) {
      pendingApprovals.delete(message.id)
      continuation(message.result)
    }
    return
  }
  if (message.method === 'initialized') return
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/1', codexHome: '/tmp/fake-codex', platformFamily: 'unix', platformOs: 'test' } })
    if (process.env.FAKE_EXIT_AFTER_INITIALIZE === '1') setImmediate(() => process.exit(17))
    return
  }
  if (message.method === 'thread/start') {
    state.requests.push({ method: message.method, params: message.params })
    const id = `thread-${Object.keys(state.threads).length + 1}`
    const thread = { id, ephemeral: Boolean(message.params.ephemeral), path: message.params.ephemeral ? null : `/tmp/${id}.jsonl`, cwd: message.params.cwd }
    state.threads[id] = thread
    save()
    send({ id: message.id, result: { thread, cwd: thread.cwd, model: 'fake', modelProvider: 'fake' } })
    send({ method: 'thread/started', params: { thread } })
    return
  }
  if (message.method === 'thread/resume') {
    state.requests.push({ method: message.method, params: message.params })
    save()
    const thread = state.threads[message.params.threadId]
    if (!thread) send({ id: message.id, error: { code: -32004, message: 'thread not found' } })
    else send({ id: message.id, result: { thread, cwd: thread.cwd, model: 'fake', modelProvider: 'fake' } })
    return
  }
  if (message.method === 'turn/start') {
    state.requests.push({ method: message.method, params: message.params })
    save()
    const turn = { id: `turn-${turnId++}`, status: 'inProgress', items: [] }
    send({ id: message.id, result: { turn } })
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn } })
    const text = message.params.input?.find(item => item.type === 'text')?.text ?? ''
    const localImage = message.params.input?.find(item => item.type === 'localImage')?.path
    const complete = () => {
      if (!activeTurns.has(turn.id)) return
      activeTurns.delete(turn.id)
      const imageSuffix = localImage ? `|localImage:${localImage}` : ''
      send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId: turn.id, itemId: 'answer', delta: `echo:${text}${imageSuffix}` } })
      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { ...turn, status: 'completed' } } })
    }
    activeTurns.set(turn.id, { threadId: message.params.threadId, turn })
    if (text === 'crash-process') {
      setImmediate(() => process.exit(19))
    } else if (text === 'approve-me') {
      const id = serverRequestId++
      pendingApprovals.set(id, result => {
        send({ method: 'approval/observed', params: { decision: result.decision } })
        complete()
      })
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: message.params.threadId, turnId: turn.id, command: 'echo safe' } })
    } else if (text !== 'wait-for-interrupt') complete()
    return
  }
  if (message.method === 'turn/interrupt') {
    const active = activeTurns.get(message.params.turnId)
    if (active && active.threadId !== message.params.threadId) {
      send({ id: message.id, error: { code: -32602, message: 'turn does not belong to thread' } })
      return
    }
    send({ id: message.id, result: {} })
    if (active) {
      activeTurns.delete(active.turn.id)
      send({ method: 'turn/completed', params: { threadId: active.threadId, turn: { ...active.turn, status: 'interrupted' } } })
    }
    return
  }
  if (message.method === 'test/emit-malformed') {
    process.stdout.write('{not-json}\n')
    send({ method: 'test/still-alive', params: { ok: true } })
    send({ id: message.id, result: { ok: true } })
    return
  }
  if (message.method === 'hang') return
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
})
