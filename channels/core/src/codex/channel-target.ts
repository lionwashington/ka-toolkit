import type { AppServerClient } from './app-server-client.ts'
import { BindingStore, type ChannelBinding, type ChannelPlatform } from '../bindings.ts'
import type { RuntimeTarget, RuntimeTargetMessage } from '../targets.ts'

export type CodexChannelEvent =
  | { type: 'turn-started'; threadId: string; turnId: string }
  | { type: 'text-delta'; threadId: string; turnId: string; delta: string }
  | { type: 'approval'; threadId: string; turnId: string; requestId: number; request: Record<string, any> }
  | { type: 'activity'; text: string }
  | { type: 'final'; threadId: string; turnId: string; text: string }
  | { type: 'error'; threadId?: string; turnId?: string; error: Error }
  | { type: 'turn-completed'; threadId: string; turnId: string; status: string }

export interface CodexChannelTargetOptions {
  name: string
  platform: ChannelPlatform
  externalChatId: string
  externalThreadId?: string
  cwd: string
  canonicalThreadId?: string
  canonicalThreadPath?: string
  client: AppServerClient
  bindings: BindingStore
  onEvent: (event: CodexChannelEvent, source: RuntimeTargetMessage) => void | Promise<void>
  now?: () => Date
}

interface PendingApproval {
  turnId: string
  resolve: (decision: { decision: 'accept' | 'decline' }) => void
  timer: NodeJS.Timeout
}

export class CodexChannelTarget implements RuntimeTarget {
  readonly runtime = 'codex'
  readonly name: string
  private readonly options: CodexChannelTargetOptions
  private binding?: ChannelBinding
  private queue: Promise<void> = Promise.resolve()
  private activeTurnId?: string
  private activeSource?: RuntimeTargetMessage
  private connected = false
  private nextApprovalId = 1
  private readonly pendingApprovals = new Map<number, PendingApproval>()

  constructor(options: CodexChannelTargetOptions) {
    this.options = options
    this.name = options.name
    this.binding = options.bindings.find(options)
    if (options.canonicalThreadId) {
      const timestamp = (options.now ?? (() => new Date()))().toISOString()
      this.binding = {
        channelName: this.name,
        platform: options.platform,
        externalChatId: options.externalChatId,
        externalThreadId: options.externalThreadId,
        runtime: 'codex',
        runtimeSessionId: options.canonicalThreadId,
        runtimeSessionPath: options.canonicalThreadPath || undefined,
        cwd: options.cwd,
        createdAt: this.binding?.runtimeSessionId === options.canonicalThreadId ? this.binding.createdAt : timestamp,
        updatedAt: timestamp,
      }
      options.bindings.put(this.binding)
    }
  }

  isAlive(): boolean { return this.connected && this.options.client.running }

  shutdown(): void {
    this.connected = false
    for (const [requestId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'decline' })
      this.pendingApprovals.delete(requestId)
    }
  }

  async connect(): Promise<void> {
    if (!this.options.client.running) {
      await this.options.client.start()
      await this.options.client.initialize()
    }
    if (this.binding) {
      await this.options.client.request('thread/resume', { threadId: this.binding.runtimeSessionId })
    }
    this.connected = true
  }

  deliver(message: RuntimeTargetMessage): Promise<void> {
    const approval = message.content.trim().match(/^\/(approve|deny)\s+(\d+)$/i)
    if (approval) return this.answerApproval(Number(approval[2]), approval[1].toLowerCase() === 'approve', message)
    if (message.content.trim() === '/stop') {
      return this.interrupt().then(interrupted => this.options.onEvent({
        type: 'activity',
        text: interrupted ? 'Interrupt requested.' : 'No active Codex turn.',
      }, message)).then(() => {})
    }
    const work = this.queue.catch(() => {}).then(() => this.runTurn(message))
    this.queue = work
    return work
  }

  ownsThread(threadId: string): boolean {
    return this.binding?.runtimeSessionId === threadId
  }

  async requestApproval(request: Record<string, any>): Promise<unknown> {
    const threadId = String(request.params?.threadId ?? '')
    const turnId = String(request.params?.turnId ?? '')
    const requestId = this.nextApprovalId++
    if (!this.ownsThread(threadId) || !turnId || !this.activeSource) {
      throw new Error('approval request does not match an active Codex turn')
    }
    await this.options.onEvent({ type: 'approval', threadId, turnId, requestId, request }, this.activeSource)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId)
        resolve({ decision: 'decline' })
      }, 5 * 60_000)
      timer.unref()
      this.pendingApprovals.set(requestId, { turnId, resolve, timer })
    })
  }

  async interrupt(): Promise<boolean> {
    if (!this.binding || !this.activeTurnId) return false
    await this.options.client.request('turn/interrupt', {
      threadId: this.binding.runtimeSessionId,
      turnId: this.activeTurnId,
    })
    return true
  }

  private async ensureBinding(): Promise<ChannelBinding> {
    if (this.binding) return this.binding
    const started = await this.options.client.request('thread/start', {
      cwd: this.options.cwd,
      ephemeral: false,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    const timestamp = (this.options.now ?? (() => new Date()))().toISOString()
    this.binding = {
      channelName: this.name,
      platform: this.options.platform,
      externalChatId: this.options.externalChatId,
      externalThreadId: this.options.externalThreadId,
      runtime: 'codex',
      runtimeSessionId: started.thread.id,
      runtimeSessionPath: started.thread.path ?? undefined,
      cwd: this.options.cwd,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.options.bindings.put(this.binding)
    return this.binding
  }

  private async runTurn(source: RuntimeTargetMessage): Promise<void> {
    let binding: ChannelBinding | undefined
    let turnId: string | undefined
    try {
      if (!this.connected || !this.options.client.running) await this.connect()
      binding = await this.ensureBinding()
      this.activeSource = source
      let text = ''
      const completed = new Promise<any>((resolve, reject) => {
        let timer: NodeJS.Timeout
        const cleanup = () => {
          this.options.client.off('notification', onNotification)
          this.options.client.off('exit', onExit)
          clearTimeout(timer)
        }
        const onExit = () => {
          cleanup()
          this.connected = false
          reject(new Error('Codex App Server exited during an active turn'))
        }
        const onNotification = (message: any) => {
          const params = message.params ?? {}
          if (params.threadId !== binding!.runtimeSessionId) return
          const eventTurnId = params.turnId ?? params.turn?.id
          if (turnId && eventTurnId && eventTurnId !== turnId) return
          if (message.method === 'turn/started') {
            turnId = params.turn.id
            this.activeTurnId = turnId
            this.persistActiveTurn(binding!, turnId)
            void this.options.onEvent({ type: 'turn-started', threadId: binding!.runtimeSessionId, turnId }, source)
          } else if (message.method === 'item/agentMessage/delta') {
            text += String(params.delta ?? '')
            void this.options.onEvent({ type: 'text-delta', threadId: binding!.runtimeSessionId, turnId: eventTurnId, delta: String(params.delta ?? '') }, source)
          } else if (message.method === 'turn/completed') {
            cleanup()
            resolve({ turn: params.turn, text })
          }
        }
        this.options.client.on('notification', onNotification)
        this.options.client.once('exit', onExit)
        timer = setTimeout(() => {
          cleanup()
          reject(new Error('Codex turn completion timed out'))
        }, 10 * 60_000).unref()
      })
      const started = await this.options.client.request('turn/start', {
        threadId: binding.runtimeSessionId,
        input: [{ type: 'text', text: source.content }],
      })
      turnId = started.turn.id
      this.activeTurnId = turnId
      this.persistActiveTurn(binding, turnId)
      const result = await completed
      if (result.text) await this.options.onEvent({ type: 'final', threadId: binding.runtimeSessionId, turnId, text: result.text }, source)
      await this.options.onEvent({ type: 'turn-completed', threadId: binding.runtimeSessionId, turnId, status: result.turn.status }, source)
    } catch (error: any) {
      await this.options.onEvent({ type: 'error', threadId: binding?.runtimeSessionId, turnId, error }, source)
      throw error
    } finally {
      this.activeTurnId = undefined
      this.activeSource = undefined
      if (binding) this.persistActiveTurn(binding, undefined)
    }
  }

  private async answerApproval(requestId: number, accept: boolean, source: RuntimeTargetMessage): Promise<void> {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending || pending.turnId !== this.activeTurnId) {
      await this.options.onEvent({ type: 'activity', text: `Approval ${requestId} is not pending.` }, source)
      return
    }
    this.pendingApprovals.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve({ decision: accept ? 'accept' : 'decline' })
    await this.options.onEvent({ type: 'activity', text: `Approval ${requestId} ${accept ? 'accepted' : 'declined'}.` }, source)
  }

  private persistActiveTurn(binding: ChannelBinding, activeTurnId: string | undefined): void {
    const updatedAt = (this.options.now ?? (() => new Date()))().toISOString()
    this.binding = { ...binding, activeTurnId, updatedAt }
    this.options.bindings.put(this.binding)
  }
}
