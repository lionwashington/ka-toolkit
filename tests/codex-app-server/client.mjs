import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super()
    this.command = options.command ?? 'codex'
    this.args = options.args ?? ['app-server']
    this.cwd = options.cwd
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.nextId = 1
    this.pending = new Map()
    this.serverRequestHandler = options.serverRequestHandler
    this.child = null
    this.stderr = ''
  }

  async start() {
    if (this.child) throw new Error('app-server client already started')
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      this.stderr += chunk
      this.emit('stderr', chunk)
    })
    createInterface({ input: child.stdout }).on('line', line => this.#onLine(line))
    child.once('error', error => this.#failAll(error))
    child.once('exit', (code, signal) => {
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : ''
      this.#failAll(new Error(`app-server exited (code=${code}, signal=${signal})${suffix}`))
      this.child = null
      this.emit('exit', { code, signal })
    })
  }

  async initialize(clientInfo = { name: 'ka-codex-spike', title: 'KA Codex Spike', version: '0.1.0' }) {
    const response = await this.request('initialize', { clientInfo, capabilities: null })
    this.notify('initialized')
    return response
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.child) return Promise.reject(new Error('app-server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`app-server request timed out: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.#write({ method, id, params })
    })
  }

  notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params })
  }

  async stop() {
    const child = this.child
    if (!child) return
    child.stdin.end()
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve()
      }, 2_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  #write(message) {
    if (!this.child?.stdin.writable) throw new Error('app-server stdin is not writable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.emit('protocol-error', new Error(`invalid app-server JSON: ${line}`, { cause: error }))
      return
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        this.emit('protocol-error', new Error(`response for unknown request id: ${message.id}`))
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      this.#handleServerRequest(message)
      return
    }
    if (message.method) this.emit('notification', message)
    else this.emit('protocol-error', new Error(`unrecognized app-server message: ${line}`))
  }

  async #handleServerRequest(message) {
    try {
      if (!this.serverRequestHandler) throw new Error(`unhandled server request: ${message.method}`)
      const result = await this.serverRequestHandler(message)
      this.#write({ id: message.id, result })
    } catch (error) {
      this.#write({ id: message.id, error: { code: -32000, message: error.message } })
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class AppServerSupervisor extends EventEmitter {
  constructor(options) {
    super()
    if (!options?.createClient) throw new Error('createClient is required')
    this.createClient = options.createClient
    this.maxRestarts = options.maxRestarts ?? 3
    this.backoffMs = options.backoffMs ?? (attempt => Math.min(100 * (2 ** (attempt - 1)), 2_000))
    this.clientInfo = options.clientInfo
    this.client = null
    this.restartCount = 0
    this.stopping = false
    this.timer = null
  }

  async start() {
    if (this.client) throw new Error('app-server supervisor already started')
    this.stopping = false
    await this.#launch(true)
    return this.client
  }

  async stop() {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const client = this.client
    this.client = null
    await client?.stop()
  }

  async #launch(throwOnFailure = false) {
    const client = this.createClient()
    this.client = client
    client.once('exit', details => this.#onExit(client, details))
    try {
      await client.start()
      await client.initialize(this.clientInfo)
      this.emit('ready', { client, restartCount: this.restartCount })
    } catch (error) {
      if (this.client === client) this.client = null
      await client.stop().catch(() => {})
      this.#scheduleRestart(error)
      if (throwOnFailure) throw error
      this.emit('restart-error', { error, attempt: this.restartCount })
    }
  }

  #onExit(client, details) {
    if (this.client !== client) return
    this.client = null
    if (!this.stopping) this.#scheduleRestart(new Error(`app-server exited (code=${details.code}, signal=${details.signal})`))
  }

  #scheduleRestart(error) {
    if (this.stopping || this.timer) return
    if (this.restartCount >= this.maxRestarts) {
      this.emit('exhausted', { error, restartCount: this.restartCount })
      return
    }
    const attempt = ++this.restartCount
    const delayMs = this.backoffMs(attempt)
    this.emit('restart-scheduled', { error, attempt, delayMs })
    this.timer = setTimeout(() => {
      this.timer = null
      this.#launch().catch(restartError => this.emit('restart-error', { error: restartError, attempt }))
    }, delayMs)
  }
}
