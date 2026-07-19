import { AppServerClient } from './app-server-client.ts'
import { CodexChannelTarget, type CodexChannelEvent } from './channel-target.ts'
import { BindingStore, type ChannelPlatform } from '../bindings.ts'
import { registerRuntimeTarget, unregisterRuntimeTarget } from '../targets.ts'
import { channelNumberOf } from '../sessions.ts'
import type { Platform } from '../platform.ts'
import { log } from '../log.ts'

export interface CodexRuntimeRegistration {
  name: string
  cwd: string
  endpoint?: string
  socketPath?: string
}

export interface CodexRuntimeConfig {
  platform: ChannelPlatform
  bindingsPath: string
  externalChatId: string
  requestTimeoutMs?: number
}

type ManagedTarget = { target: CodexChannelTarget; client: AppServerClient }

export class CodexRuntimeManager {
  private readonly platform: Platform
  private readonly config: CodexRuntimeConfig
  private readonly bindings: BindingStore
  private readonly targets = new Map<string, ManagedTarget>()
  private readonly streams = new Map<string, {
    prefix: string; text: string; handle: Promise<unknown>; lastUpdate: number; timer?: NodeJS.Timeout
  }>()

  constructor(platform: Platform, config: CodexRuntimeConfig) {
    this.platform = platform
    this.config = config
    this.bindings = new BindingStore(config.bindingsPath)
  }

  async register(item: CodexRuntimeRegistration): Promise<void> {
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
      platform: this.config.platform,
      externalChatId: this.config.externalChatId,
      client,
      bindings: this.bindings,
      onEvent: (event, source) => this.onEvent(item.name, event, source.meta.chat_id || this.config.externalChatId),
    })
    try {
      await target.connect()
      registerRuntimeTarget(target)
      this.targets.set(item.name, { target, client })
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
        if (stream.timer) clearTimeout(stream.timer)
        const error = await this.platform.finishStream(await stream.handle, `${stream.prefix}${event.text}`)
        this.streams.delete(event.turnId)
        if (error) throw new Error(error)
        return
      }
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (!target) throw new Error(`reply target not allowed: ${replyTarget}`)
      const error = await this.platform.send(target, `**[#${channelNumberOf(name)}-${name}]** ${event.text}`)
      if (error) throw new Error(error)
    } else if (event.type === 'activity') {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) await this.platform.send(target, `**[#${channelNumberOf(name)}-${name}]** ${event.text}`)
    } else if (event.type === 'approval') {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) {
        const command = String(event.request.params?.command ?? 'requested action')
        await this.platform.send(target, `⚠️ ${name} requests approval ${event.requestId}: ${command}\nReply with \`to ${name}: /approve ${event.requestId}\` or \`to ${name}: /deny ${event.requestId}\`.`)
      }
    } else if (event.type === 'error') {
      log(`codex target ${name} failed: ${event.error.message}`)
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) await this.platform.send(target, `⚠️ ${name}: Codex turn failed: ${event.error.message}`)
    }
  }

  private scheduleStreamUpdate(turnId: string, stream: { prefix: string; text: string; handle: Promise<unknown>; lastUpdate: number; timer?: NodeJS.Timeout }): void {
    if (!this.platform.updateStream || stream.timer) return
    const delay = Math.max(0, 750 - (Date.now() - stream.lastUpdate))
    stream.timer = setTimeout(async () => {
      stream.timer = undefined
      const current = this.streams.get(turnId)
      if (!current || !this.platform.updateStream) return
      const error = await this.platform.updateStream(await current.handle, `${current.prefix}${current.text}`)
      current.lastUpdate = Date.now()
      if (error) log(`codex stream update failed: ${error}`)
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
