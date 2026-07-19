import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { createConnection, type Socket } from 'node:net'

type JsonObject = Record<string, any>

export interface AppServerClientOptions {
  command?: string
  args?: string[]
  socketPath?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  serverRequestHandler?: (request: JsonObject) => Promise<unknown>
}

interface PendingRequest {
  method: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class AppServerClient extends EventEmitter {
  readonly command: string
  readonly args: string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly requestTimeoutMs: number
  readonly serverRequestHandler?: (request: JsonObject) => Promise<unknown>
  private child: ChildProcessWithoutNullStreams | null = null
  private socket: Socket | null = null
  private stopping = false
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stderr = ''

  constructor(options: AppServerClientOptions = {}) {
    super()
    this.command = options.command ?? 'codex'
    this.args = options.args ?? ['app-server']
    this.cwd = options.cwd
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.serverRequestHandler = options.serverRequestHandler
    this.socketPath = options.socketPath
  }

  readonly socketPath?: string

  get running(): boolean { return this.child !== null || this.socket !== null }

  async start(): Promise<void> {
    if (this.running) throw new Error('app-server client already started')
    this.stopping = false
    if (this.socketPath) {
      await this.connectSocket(this.socketPath)
      return
    }
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
    createInterface({ input: child.stdout }).on('line', line => this.onLine(line))
    child.once('error', error => this.failAll(error))
    child.once('exit', (code, signal) => {
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : ''
      this.failAll(new Error(`app-server exited (code=${code}, signal=${signal})${suffix}`))
      this.child = null
      this.emit('exit', { code, signal })
    })
  }

  async initialize(clientInfo = { name: 'ka-channel', title: 'KA Channel', version: '0.1.0' }): Promise<any> {
    const response = await this.request('initialize', { clientInfo, capabilities: null })
    this.notify('initialized')
    return response
  }

  request(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<any> {
    if (!this.running) return Promise.reject(new Error('app-server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`app-server request timed out: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.write({ method, id, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  async stop(): Promise<void> {
    if (this.socket) {
      this.stopping = true
      const socket = this.socket
      this.socket = null
      socket.end()
      socket.destroy()
      this.failAll(new Error('app-server connection closed'))
      return
    }
    const child = this.child
    if (!child) return
    this.stopping = true
    child.stdin.end()
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 2_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  private write(message: JsonObject): void {
    const line = `${JSON.stringify(message)}\n`
    if (this.socket?.writable) { this.socket.write(line); return }
    if (this.child?.stdin.writable) { this.child.stdin.write(line); return }
    throw new Error('app-server transport is not writable')
  }

  private connectSocket(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath)
      let settled = false
      socket.setEncoding('utf8')
      createInterface({ input: socket }).on('line', line => this.onLine(line))
      socket.once('connect', () => {
        settled = true
        this.socket = socket
        resolve()
      })
      socket.once('error', error => {
        if (!settled) reject(error)
        this.failAll(error)
        this.emit('transport-error', error)
      })
      socket.once('close', () => {
        if (this.socket === socket) this.socket = null
        const error = new Error('app-server socket closed')
        this.failAll(error)
        this.emit('exit', { code: null, signal: null })
      })
    })
  }

  private onLine(line: string): void {
    let message: JsonObject
    try { message = JSON.parse(line) }
    catch (error) {
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
    if (message.id !== undefined && message.method) { void this.handleServerRequest(message); return }
    if (message.method) this.emit('notification', message)
    else this.emit('protocol-error', new Error(`unrecognized app-server message: ${line}`))
  }

  private async handleServerRequest(message: JsonObject): Promise<void> {
    try {
      if (!this.serverRequestHandler) throw new Error(`unhandled server request: ${message.method}`)
      this.write({ id: message.id, result: await this.serverRequestHandler(message) })
    } catch (error: any) {
      if (this.stopping) return
      try {
        this.write({ id: message.id, error: { code: -32000, message: error?.message ?? String(error) } })
      } catch (writeError: any) {
        this.emit('protocol-error', new Error(`cannot answer app-server request: ${writeError?.message ?? writeError}`))
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
