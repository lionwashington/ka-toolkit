import { AppServerClient } from './app-server-client.ts'
import { CodexChannelTarget, type CodexChannelEvent } from './channel-target.ts'
import { BindingStore, type ChannelPlatform } from '../bindings.ts'
import { registerRuntimeTarget, unregisterRuntimeTarget } from '../targets.ts'
import { channelNumberOf } from '../sessions.ts'
import type { Platform } from '../platform.ts'
import { log } from '../log.ts'
import { counters } from '../counters.ts'

export interface CodexRuntimeRegistration {
  name: string
  cwd: string
  endpoint?: string
  socketPath?: string
  threadId?: string
  threadPath?: string
}

export interface CodexRuntimeConfig {
  platform: ChannelPlatform
  bindingsPath: string
  externalChatId: string
  requestTimeoutMs?: number
}

type ManagedTarget = { target: CodexChannelTarget; client: AppServerClient; registration: CodexRuntimeRegistration }

interface ActiveStream {
  prefix: string
  text: string
  handle: Promise<unknown>
  lastUpdate: number
  timer?: NodeJS.Timeout
  update?: Promise<void>
}

export class CodexRuntimeManager {
  private readonly platform: Platform
  private readonly config: CodexRuntimeConfig
  private readonly bindings: BindingStore
  private readonly targets = new Map<string, ManagedTarget>()
  private readonly streams = new Map<string, ActiveStream>()

  constructor(platform: Platform, config: CodexRuntimeConfig) {
    this.platform = platform
    this.config = config
    this.bindings = new BindingStore(config.bindingsPath)
  }

  async register(item: CodexRuntimeRegistration): Promise<void> {
    const current = this.targets.get(item.name)
    // The Workshop registrar intentionally retries registration whenever its
    // status probe is inconclusive. Treat the App Server endpoint + canonical
    // thread as the runtime identity. Metadata such as threadPath may be absent
    // in one retry and present in the next; replacing the client for that change
    // closes an otherwise healthy WebSocket and aborts an active channel turn.
    if (current && sameRuntimeIdentity(current.registration, item)) {
      current.registration = { ...current.registration, ...item }
      return
    }
    await this.unregister(item.name)
    const client = new AppServerClient({
      endpoint: item.endpoint,
      socketPath: item.socketPath,
      requestTimeoutMs: this.config.requestTimeoutMs,
      serverRequestHandler: request => this.handleServerRequest(request),
    })
    await client.start()
    await client.initialize()
    const target = new CodexChannelTarget({
      name: item.name,
      cwd: item.cwd,
      canonicalThreadId: item.threadId,
      canonicalThreadPath: item.threadPath,
      platform: this.config.platform,
      externalChatId: this.config.externalChatId,
      client,
      bindings: this.bindings,
      onEvent: (event, source) => this.onEvent(item.name, event, source.meta.chat_id || this.config.externalChatId),
    })
    try {
      await target.connect()
      registerRuntimeTarget(target)
      this.targets.set(item.name, { target, client, registration: { ...item } })
      log(`codex target registered: ${item.name} (${item.endpoint ?? item.socketPath})`)
    } catch (error) {
      target.shutdown()
      await client.stop()
      throw error
    }
  }

  async unregister(name: string): Promise<boolean> {
    const managed = this.targets.get(name)
    if (!managed) return false
    this.targets.delete(name)
    managed.target.shutdown()
    unregisterRuntimeTarget(name, managed.target)
    await managed.client.stop()
    log(`codex target unregistered: ${name}`)
    return true
  }

  async stop(): Promise<void> {
    await Promise.all(Array.from(this.targets.keys(), name => this.unregister(name)))
    for (const stream of this.streams.values()) if (stream.timer) clearTimeout(stream.timer)
    this.streams.clear()
  }

  registrations(): Array<{ name: string; alive: boolean }> {
    return Array.from(this.targets, ([name, managed]) => ({ name, alive: managed.target.isAlive() }))
  }

  private async onEvent(name: string, event: CodexChannelEvent, replyTarget: string): Promise<void> {
    if (event.type === 'turn-started' && this.platform.startStream) {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) {
        const prefix = `**[#${channelNumberOf(name)}-${name}]** `
        this.streams.set(event.turnId, { prefix, text: '', handle: this.platform.startStream(target, `${prefix}…`), lastUpdate: 0 })
      }
    } else if (event.type === 'text-delta') {
      const stream = this.streams.get(event.turnId)
      if (stream) { stream.text += event.delta; this.scheduleStreamUpdate(event.turnId, stream) }
    } else if (event.type === 'final') {
      const stream = this.streams.get(event.turnId)
      if (stream && this.platform.finishStream) {
        const error = await this.finishStream(event.turnId, stream, event.text)
        if (error) throw new Error(error)
        counters.replies++
        log(`codex target ${name} replied (turn=${event.turnId})`)
        return
      }
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (!target) throw new Error(`reply target not allowed: ${replyTarget}`)
      const error = await this.platform.send(target, `**[#${channelNumberOf(name)}-${name}]** ${event.text}`)
      if (error) throw new Error(error)
      counters.replies++
      log(`codex target ${name} replied (turn=${event.turnId})`)
    } else if (event.type === 'activity') {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) await this.platform.send(target, `**[#${channelNumberOf(name)}-${name}]** ${event.text}`)
    } else if (event.type === 'approval') {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) {
        const action = describeApproval(event.request)
        await this.platform.send(target, `⚠️ ${name} requests approval ${event.requestId}: ${action}\nReply with \`to ${name}: /approve ${event.requestId}\` or \`to ${name}: /deny ${event.requestId}\`.`)
      }
    } else if (event.type === 'error') {
      log(`codex target ${name} failed: ${event.error.message}`)
      counters.repliesFailed++
      const stream = event.turnId ? this.streams.get(event.turnId) : undefined
      if (stream && this.platform.finishStream) {
        const suffix = stream.text ? `\n\n⚠️ Codex turn failed: ${event.error.message}` : `⚠️ Codex turn failed: ${event.error.message}`
        const streamError = await this.finishStream(event.turnId!, stream, `${stream.text}${suffix}`)
          .catch(error => error?.message ?? String(error))
        if (!streamError) return
        log(`codex stream failure fallback failed: ${streamError}`)
      }
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) await this.platform.send(target, `⚠️ ${name}: Codex turn failed: ${event.error.message}`)
    } else if (event.type === 'turn-completed') {
      // A completed/interrupted/failed turn is not guaranteed to contain an
      // agent-message delta. Close any placeholder stream so Lark never leaves
      // a permanent "Generating response…" card behind.
      const stream = this.streams.get(event.turnId)
      if (stream && this.platform.finishStream) {
        const text = stream.text || completionNotice(event.status)
        const error = await this.finishStream(event.turnId, stream, text)
        if (error) throw new Error(error)
        counters.replies++
        log(`codex target ${name} closed empty stream (turn=${event.turnId}, status=${event.status})`)
      }
    }
  }

  private async finishStream(turnId: string, stream: ActiveStream, text: string): Promise<string | null> {
    try {
      if (stream.timer) clearTimeout(stream.timer)
      if (stream.update) await stream.update
      return await this.platform.finishStream!(await stream.handle, `${stream.prefix}${text}`)
    } finally {
      this.streams.delete(turnId)
    }
  }

  private scheduleStreamUpdate(turnId: string, stream: ActiveStream): void {
    if (!this.platform.updateStream || stream.timer || stream.update) return
    const delay = Math.max(0, 750 - (Date.now() - stream.lastUpdate))
    stream.timer = setTimeout(() => {
      stream.timer = undefined
      const current = this.streams.get(turnId)
      if (!current || !this.platform.updateStream) return
      current.update = (async () => {
        const error = await this.platform.updateStream!(await current.handle, `${current.prefix}${current.text}`)
        current.lastUpdate = Date.now()
        if (error) log(`codex stream update failed: ${error}`)
      })().finally(() => { current.update = undefined })
    }, delay)
    stream.timer.unref()
  }

  private async handleServerRequest(request: Record<string, any>): Promise<unknown> {
    const threadId = String(request.params?.threadId ?? '')
    const managed = Array.from(this.targets.values()).find(candidate => candidate.target.ownsThread(threadId))
    if (!managed) throw new Error(`approval request for unknown Codex thread: ${threadId}`)
    return managed.target.requestApproval(request)
  }
}

function completionNotice(status: string): string {
  if (status === 'interrupted') return 'Codex turn interrupted.'
  if (status === 'failed') return 'Codex turn failed without a text response.'
  return 'Codex completed without a text response.'
}

function sameRuntimeIdentity(left: CodexRuntimeRegistration, right: CodexRuntimeRegistration): boolean {
  return left.name === right.name && left.cwd === right.cwd && left.endpoint === right.endpoint &&
    left.socketPath === right.socketPath && left.threadId === right.threadId
}

export function describeApproval(request: Record<string, any>): string {
  const params = request.params ?? {}
  if (typeof params.command === 'string' && params.command.trim()) return params.command.trim()
  if (typeof params.reason === 'string' && params.reason.trim()) return params.reason.trim()
  if (params.permissions) return `permissions: ${JSON.stringify(params.permissions)}`
  if (typeof params.grantRoot === 'string' && params.grantRoot) return `write access: ${params.grantRoot}`
  const method = String(request.method ?? '')
  if (method.includes('fileChange')) return 'apply file changes'
  if (method.includes('commandExecution')) return 'execute command'
  if (method.includes('permissions')) return 'change permissions'
  return 'requested action'
}
