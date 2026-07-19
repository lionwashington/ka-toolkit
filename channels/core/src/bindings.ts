import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type ChannelPlatform = 'telegram' | 'lark'
export type ChannelRuntime = 'cc' | 'codex'

export interface ChannelBinding {
  channelName: string
  platform: ChannelPlatform
  externalChatId: string
  externalThreadId?: string
  runtime: ChannelRuntime
  runtimeSessionId: string
  runtimeSessionPath?: string
  cwd: string
  activeTurnId?: string
  createdAt: string
  updatedAt: string
}

interface BindingFile {
  version: 1
  bindings: Record<string, ChannelBinding>
}

function bindingKey(binding: Pick<ChannelBinding, 'platform' | 'externalChatId' | 'externalThreadId' | 'channelName'>): string {
  return [binding.platform, binding.externalChatId, binding.externalThreadId ?? '', binding.channelName]
    .map(value => encodeURIComponent(value))
    .join(':')
}

function emptyFile(): BindingFile { return { version: 1, bindings: {} } }

export class BindingStore {
  readonly filePath: string
  private data: BindingFile

  constructor(filePath: string) {
    this.filePath = filePath
    this.data = this.load()
  }

  list(): ChannelBinding[] { return Object.values(this.data.bindings) }

  find(input: Pick<ChannelBinding, 'platform' | 'externalChatId' | 'externalThreadId' | 'channelName'>): ChannelBinding | undefined {
    return this.data.bindings[bindingKey(input)]
  }

  put(binding: ChannelBinding): void {
    this.data.bindings[bindingKey(binding)] = { ...binding }
    this.persist()
  }

  remove(input: Pick<ChannelBinding, 'platform' | 'externalChatId' | 'externalThreadId' | 'channelName'>): boolean {
    const key = bindingKey(input)
    if (!this.data.bindings[key]) return false
    delete this.data.bindings[key]
    this.persist()
    return true
  }

  private load(): BindingFile {
    let raw: string
    try { raw = readFileSync(this.filePath, 'utf8') }
    catch (error: any) {
      if (error?.code === 'ENOENT') return emptyFile()
      throw error
    }
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !parsed.bindings || Array.isArray(parsed.bindings)) {
      throw new Error(`unsupported channel binding file: ${this.filePath}`)
    }
    return parsed as BindingFile
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }
}
