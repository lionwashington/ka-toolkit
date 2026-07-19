import { AppServerClient, type AppServerClientOptions } from './app-server-client.ts'
import { CodexChannelTarget, type CodexChannelEvent } from './channel-target.ts'
import { BindingStore, type ChannelPlatform } from '../bindings.ts'
import { registerRuntimeTarget, unregisterRuntimeTarget } from '../targets.ts'
import { channelNumberOf } from '../sessions.ts'
import type { Platform } from '../platform.ts'
import { log } from '../log.ts'

export interface CodexTargetConfig {
  name: string
  cwd: string
  externalChatId: string
  externalThreadId?: string
}

export interface CodexRuntimeConfig {
  platform: ChannelPlatform
  bindingsPath: string
  targets: CodexTargetConfig[]
  client?: AppServerClientOptions
}

export class CodexRuntimeManager {
  private readonly platform: Platform
  private readonly config: CodexRuntimeConfig
  private readonly client: AppServerClient
  private readonly targets: CodexChannelTarget[] = []
  private readonly streams = new Map<string, {
    prefix: string
    text: string
    handle: Promise<unknown>
    lastUpdate: number
    timer?: NodeJS.Timeout
  }>()

  constructor(platform: Platform, config: CodexRuntimeConfig) {
    this.platform = platform
    this.config = config
    this.client = new AppServerClient({
      ...config.client,
      serverRequestHandler: request => this.handleServerRequest(request),
    })
  }

  async start(): Promise<void> {
    if (this.config.targets.length === 0) return
    await this.client.start()
    await this.client.initialize()
    const bindings = new BindingStore(this.config.bindingsPath)
    try {
      for (const item of this.config.targets) {
        const target = new CodexChannelTarget({
          ...item,
          platform: this.config.platform,
          client: this.client,
          bindings,
          onEvent: (event, source) => this.onEvent(item.name, event, source.meta.chat_id || item.externalChatId),
        })
        await target.connect()
        registerRuntimeTarget(target)
        this.targets.push(target)
        log(`codex target online: ${item.name} (${item.cwd})`)
      }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    for (const target of this.targets) {
      target.shutdown()
      unregisterRuntimeTarget(target.name, target)
    }
    this.targets.length = 0
    for (const stream of this.streams.values()) {
      if (stream.timer) clearTimeout(stream.timer)
    }
    this.streams.clear()
    await this.client.stop()
  }

  private async onEvent(name: string, event: CodexChannelEvent, replyTarget: string): Promise<void> {
    if (event.type === 'turn-started' && this.platform.startStream) {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) {
        const prefix = `**[#${channelNumberOf(name)}-${name}]** `
        this.streams.set(event.turnId, {
          prefix,
          text: '',
          handle: this.platform.startStream(target, `${prefix}…`),
          lastUpdate: 0,
        })
      }
    } else if (event.type === 'text-delta') {
      const stream = this.streams.get(event.turnId)
      if (stream) {
        stream.text += event.delta
        this.scheduleStreamUpdate(event.turnId, stream)
      }
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
      const prefix = `**[#${channelNumberOf(name)}-${name}]** `
      const error = await this.platform.send(target, `${prefix}${event.text}`)
      if (error) throw new Error(error)
    } else if (event.type === 'activity') {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) await this.platform.send(target, `**[#${channelNumberOf(name)}-${name}]** ${event.text}`)
    } else if (event.type === 'approval') {
      const target = this.platform.resolveReplyTarget(replyTarget)
      if (target) {
        const command = String(event.request.params?.command ?? 'requested action')
        await this.platform.send(target,
          `⚠️ ${name} requests approval ${event.requestId}: ${command}\n` +
          `Reply with \`to ${name}: /approve ${event.requestId}\` or \`to ${name}: /deny ${event.requestId}\`.`)
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
    const target = this.targets.find(candidate => candidate.ownsThread(threadId))
    if (!target) throw new Error(`approval request for unknown Codex thread: ${threadId}`)
    return target.requestApproval(request)
  }
}
