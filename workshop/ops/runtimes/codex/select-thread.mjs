#!/usr/bin/env node

const [endpoint, cwd, requestedThreadId = ''] = process.argv.slice(2)
if (!endpoint || !cwd) throw new Error('usage: select-thread.mjs <endpoint> <cwd> [thread-id]')

const websocket = new WebSocket(endpoint)
let nextId = 1
const pending = new Map()

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 15_000)
    pending.set(id, { method, resolve, reject, timer })
    websocket.send(JSON.stringify({ method, id, params }))
  })
}

await new Promise((resolve, reject) => {
  websocket.addEventListener('open', resolve, { once: true })
  websocket.addEventListener('error', () => reject(new Error(`cannot connect to ${endpoint}`)), { once: true })
})

websocket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id === undefined || (!('result' in message) && !('error' in message))) return
  const item = pending.get(message.id)
  if (!item) return
  clearTimeout(item.timer)
  pending.delete(message.id)
  if (message.error) item.reject(new Error(`${item.method}: ${message.error.message ?? JSON.stringify(message.error)}`))
  else item.resolve(message.result)
})

try {
  await request('initialize', {
    clientInfo: { name: 'ka_workshop', title: 'KA Workshop', version: '0.1.0' },
    capabilities: null,
  })
  websocket.send(JSON.stringify({ method: 'initialized', params: {} }))

  let thread
  if (requestedThreadId) {
    const resumed = await request('thread/resume', { threadId: requestedThreadId })
    thread = resumed.thread
    if (thread.cwd !== cwd) {
      throw new Error(`thread ${requestedThreadId} belongs to ${thread.cwd}, expected ${cwd}`)
    }
  } else {
    const listed = await request('thread/list', {
      cwd,
      limit: 20,
      sortKey: 'recency_at',
      sortDirection: 'desc',
    })
    let latest
    for (const candidate of listed.data ?? []) {
      const read = await request('thread/read', {
        threadId: candidate.id,
        includeTurns: true,
      })
      const turns = read.thread?.turns ?? []
      const lastTurn = turns.at(-1)
      // An incomplete turn may still be owned by another Codex process and
      // can contain host-specific tool calls whose outputs are unavailable to
      // Workshop. Only auto-adopt a safely completed history. An explicit
      // thread id above remains an intentional exact override.
      if (!lastTurn || lastTurn.status === 'completed') {
        latest = candidate
        break
      }
    }
    if (!latest) {
      const started = await request('thread/start', {
        cwd,
        ephemeral: false,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      })
      thread = started.thread
    } else {
      // Remote TUI resume can replay transient runtime events from any stored
      // thread, including one previously owned by Workshop. That may render a
      // permanent stale "Working" state even though App Server is idle, and
      // large histories can make the TUI exit during replay. Fork on every
      // implicit launch: history is preserved, while runtime state is clean.
      const forked = await request('thread/fork', {
        threadId: latest.id,
        ephemeral: false,
      })
      thread = forked.thread
    }
  }
  process.stdout.write(`${JSON.stringify({ id: thread.id, path: thread.path ?? null, cwd: thread.cwd })}\n`)
} finally {
  websocket.close()
}
