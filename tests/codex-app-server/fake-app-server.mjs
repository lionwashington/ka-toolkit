import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'

const statePath = process.env.FAKE_CODEX_STATE
let state = { threads: {} }
try { if (statePath) state = JSON.parse(readFileSync(statePath, 'utf8')) } catch {}

function save() { if (statePath) writeFileSync(statePath, JSON.stringify(state)) }
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }

let serverRequestId = 10_000
const pendingApprovals = new Map()

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
    return
  }
  if (message.method === 'thread/start') {
    const id = `thread-${Object.keys(state.threads).length + 1}`
    const thread = { id, ephemeral: Boolean(message.params.ephemeral), path: message.params.ephemeral ? null : `/tmp/${id}.jsonl`, cwd: message.params.cwd }
    state.threads[id] = thread
    save()
    send({ id: message.id, result: { thread, cwd: thread.cwd, model: 'fake', modelProvider: 'fake' } })
    send({ method: 'thread/started', params: { thread } })
    return
  }
  if (message.method === 'thread/resume') {
    const thread = state.threads[message.params.threadId]
    if (!thread) send({ id: message.id, error: { code: -32004, message: 'thread not found' } })
    else send({ id: message.id, result: { thread, cwd: thread.cwd, model: 'fake', modelProvider: 'fake' } })
    return
  }
  if (message.method === 'turn/start') {
    const turn = { id: `turn-${Date.now()}`, status: 'inProgress', items: [] }
    send({ id: message.id, result: { turn } })
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn } })
    const text = message.params.input?.[0]?.text ?? ''
    const complete = () => {
      send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId: turn.id, itemId: 'answer', delta: `echo:${text}` } })
      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { ...turn, status: 'completed' } } })
    }
    if (text === 'approve-me') {
      const id = serverRequestId++
      pendingApprovals.set(id, result => {
        send({ method: 'approval/observed', params: { decision: result.decision } })
        complete()
      })
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: message.params.threadId, turnId: turn.id, command: 'echo safe' } })
    } else complete()
    return
  }
  if (message.method === 'hang') return
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
})

