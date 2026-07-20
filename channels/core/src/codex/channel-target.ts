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
  turnInactivityTimeoutMs?: number
  transportRecoveryTimeoutMs?: number
}

type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i
const DANGER_FULL_ACCESS = { type: 'dangerFullAccess' } as const

/** Map a platform message to the current Codex App Server UserInput schema. */
export function buildCodexTurnInput(source: RuntimeTargetMessage): CodexUserInput[] {
  const path = source.meta.attachment_path?.trim()
  const kind = source.meta.attachment_kind?.trim().toLowerCase()
  const isImage = Boolean(path && (kind === 'photo' || kind === 'image' || kind === 'sticker' || IMAGE_EXTENSIONS.test(path)))
  // App Server exposes a first-class localImage input but no generic local-file
  // input. Include the downloaded path for other attachment types so Codex can
  // inspect them with its normal filesystem tools.
  const text = path && !isImage ? `${source.content}\n\nLocal attachment path: ${path}` : source.content
  const input: CodexUserInput[] = [{ type: 'text', text, text_elements: [] }]
  if (path && isImage) {
    input.push({ type: 'localImage', path })
  }
  return input
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
  private threadBusy = false
  private observing = false
  private shuttingDown = false
  private readonly idleWaiters = new Set<() => void>()
  private readonly pendingApprovals = new Map<number, PendingApproval>()

  constructor(options: CodexChannelTargetOptions) {
    this.options = options
    this.name = options.name
    this.binding = options.bindings.find({
      channelName: options.name,
      platform: options.platform,
      externalChatId: options.externalChatId,
      externalThreadId: options.externalThreadId,
    })
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
    this.shuttingDown = true
    this.connected = false
    if (this.observing) this.options.client.off('notification', this.observeThreadState)
    this.observing = false
    this.markThreadIdle()
    for (const [requestId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'decline' })
      this.pendingApprovals.delete(requestId)
    }
  }

  async connect(): Promise<void> {
    this.shuttingDown = false
    if (!this.options.client.running) {
      await this.options.client.start()
      await this.options.client.initialize()
    }
    if (!this.observing) {
      this.options.client.on('notification', this.observeThreadState)
      this.observing = true
    }
    if (this.binding) {
      const resumed = await this.options.client.request('thread/resume', {
        threadId: this.binding.runtimeSessionId,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
      this.threadBusy = resumed.thread?.status?.type === 'active'
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
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
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
      await this.waitUntilThreadIdle()
      this.activeSource = source
      let text = ''
      const completed = new Promise<any>((resolve, reject) => {
        let timer: NodeJS.Timeout
        const armInactivityTimer = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            cleanup()
            reject(new Error('Codex turn produced no activity before the inactivity timeout'))
          }, this.options.turnInactivityTimeoutMs ?? 60 * 60_000)
          timer.unref()
        }
        const cleanup = () => {
          this.options.client.off('notification', onNotification)
          this.options.client.off('exit', onExit)
          this.options.client.off('transport-close', onTransportClose)
          clearTimeout(timer)
        }
        const onExit = () => {
          cleanup()
          this.connected = false
          reject(new Error('Codex App Server exited during an active turn'))
        }
        const onTransportClose = () => {
          this.connected = false
          if (this.shuttingDown || !this.options.client.reconnectable) {
            cleanup()
            reject(new Error('Codex App Server connection was lost during an active turn'))
            return
          }
          void this.recoverActiveTurn(binding!, turnId).then(recovered => {
            if (recovered) {
              cleanup()
              resolve({ turn: recovered, text: finalAgentText(recovered) || text })
            } else {
              this.options.client.once('transport-close', onTransportClose)
            }
          }, error => {
            cleanup()
            reject(new Error('Codex App Server connection was lost during an active turn', { cause: error }))
          })
        }
        const onNotification = (message: any) => {
          const params = message.params ?? {}
          if (params.threadId !== binding!.runtimeSessionId) return
          const eventTurnId = params.turnId ?? params.turn?.id
          if (turnId && eventTurnId && eventTurnId !== turnId) return
          // A Codex turn may legitimately run for hours. Any notification for
          // this turn proves that it is still making progress, so only fail on
          // prolonged inactivity rather than total wall-clock duration.
          if (!turnId || !eventTurnId || eventTurnId === turnId) armInactivityTimer()
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
        this.options.client.once('transport-close', onTransportClose)
        armInactivityTimer()
      })
      // `turn/start` and the completion watcher can reject from the same
      // transport close. Mark the watcher handled immediately so a rejected
      // start request cannot leave a second, orphaned rejection behind.
      void completed.catch(() => {})
      const started = await this.options.client.request('turn/start', {
        threadId: binding.runtimeSessionId,
        input: buildCodexTurnInput(source),
        approvalPolicy: 'never',
        sandboxPolicy: DANGER_FULL_ACCESS,
      })
      turnId = started.turn.id
      this.activeTurnId = turnId
      this.persistActiveTurn(binding, turnId)
      const result = await completed
      const finalText = result.text || finalAgentText(result.turn)
      if (finalText) await this.options.onEvent({ type: 'final', threadId: binding.runtimeSessionId, turnId, text: finalText }, source)
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

  private async recoverActiveTurn(binding: ChannelBinding, turnId: string | undefined): Promise<any | undefined> {
    if (!turnId) throw new Error('active Codex turn id was not recorded')
    const deadline = Date.now() + (this.options.transportRecoveryTimeoutMs ?? 60_000)
    let lastError: unknown
    let attempt = 0
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error('Codex target is shutting down')
      try {
        await this.options.client.reconnect()
        await this.options.client.request('thread/resume', {
          threadId: binding.runtimeSessionId,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        })
        this.connected = true
        const read = await this.options.client.request('thread/read', {
          threadId: binding.runtimeSessionId,
          includeTurns: true,
        })
        const turn = read.thread?.turns?.find((candidate: any) => candidate.id === turnId)
        if (!turn) throw new Error(`active turn not found after reconnect: ${turnId}`)
        return turn.status === 'inProgress' ? undefined : turn
      } catch (error) {
        lastError = error
        attempt++
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await new Promise(resolve => setTimeout(resolve, Math.min(250 * attempt, 2_000, remaining)))
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`Codex App Server did not recover within the transport recovery window: ${detail}`, {
      cause: lastError,
    })
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

  private readonly observeThreadState = (message: any): void => {
    if (!this.binding || message.params?.threadId !== this.binding.runtimeSessionId) return
    if (message.method === 'turn/started') this.threadBusy = true
    if (message.method === 'turn/completed' || (message.method === 'thread/status/changed' && message.params?.status?.type === 'idle')) {
      this.markThreadIdle()
    }
  }

  private markThreadIdle(): void {
    this.threadBusy = false
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private async waitUntilThreadIdle(): Promise<void> {
    if (!this.threadBusy) return
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.idleWaiters.delete(done); resolve() }
      const timer = setTimeout(() => {
        this.idleWaiters.delete(done)
        reject(new Error('Codex thread remained busy for 10 minutes'))
      }, 10 * 60_000)
      timer.unref()
      this.idleWaiters.add(done)
    })
  }
}

function finalAgentText(turn: any): string {
  const messages = Array.isArray(turn?.items)
    ? turn.items.filter((item: any) => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text)
    : []
  return messages.at(-1)?.text ?? ''
}
