import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type { ConversationMessage } from '@ka/core'

interface Args {
  jsonl: string
  offset?: number
  messageCount: number
  upperOffset?: number
  format: 'json' | 'markdown-json' | 'snapshot'
  batch: number
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { messageCount: 0, format: 'markdown-json', batch: 1 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`flag ${flag} requires value`)
      return value
    }
    switch (flag) {
      case '--jsonl': args.jsonl = next(); break
      case '--offset': args.offset = Number(next()); break
      // Accepted for interface compatibility. Codex rollout records do not
      // expose Claude's stable per-entry UUID sentinel.
      case '--last-entry-uuid': next(); break
      case '--message-count': args.messageCount = Number(next()); break
      case '--upper-offset': args.upperOffset = Number(next()); break
      case '--format': args.format = next() as Args['format']; break
      case '--batch': args.batch = Number(next()); break
      default: throw new Error(`unknown flag: ${flag}`)
    }
  }
  if (!args.jsonl) throw new Error('--jsonl is required')
  if (!['json', 'markdown-json', 'snapshot'].includes(args.format!)) throw new Error('invalid --format')
  return args as Args
}

function extract(line: string): ConversationMessage | null {
  try {
    const record = JSON.parse(line) as {
      timestamp?: string
      type?: string
      payload?: { type?: string; message?: unknown }
    }
    if (record.type !== 'event_msg') return null
    if (record.payload?.type !== 'user_message' && record.payload?.type !== 'agent_message') return null
    if (typeof record.payload.message !== 'string' || !record.payload.message.trim()) return null
    return {
      role: record.payload.type === 'user_message' ? 'user' : 'assistant',
      content: record.payload.message,
      timestamp: record.timestamp ?? '',
    }
  } catch {
    return null
  }
}

function scan(path: string, start: number, end: number): ConversationMessage[] {
  if (end <= start) return []
  const fd = openSync(path, 'r')
  const messages: ConversationMessage[] = []
  let position = start
  let leftover = ''
  try {
    while (position < end) {
      const length = Math.min(1024 * 1024, end - position)
      const buffer = Buffer.alloc(length)
      const bytesRead = readSync(fd, buffer, 0, length, position)
      if (bytesRead === 0) break
      const lines = (leftover + buffer.toString('utf8', 0, bytesRead)).split('\n')
      leftover = lines.pop() ?? ''
      for (const line of lines) {
        const message = extract(line.trim())
        if (message) messages.push(message)
      }
      position += bytesRead
    }
    // The snapshot may end exactly after a complete record without a newline.
    if (leftover.trim()) {
      const message = extract(leftover.trim())
      if (message) messages.push(message)
    }
  } finally {
    closeSync(fd)
  }
  return messages
}

function render(messages: ConversationMessage[], batch: number, parsedAt: string, fellBack: boolean): string {
  if (messages.length === 0) return ''
  const suffix = fellBack ? ' (full re-scan after fallback)' : ''
  const body = messages.map(message =>
    `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content}`,
  ).join('\n\n')
  return `<!-- batch ${batch} @ ${parsedAt}${suffix} -->\n\n${body}`
}

function main(): void {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`ka-codex-rollout-reader: ${(error as Error).message}\n`)
    process.exit(1)
  }
  if (!existsSync(args.jsonl)) {
    process.stderr.write(`ka-codex-rollout-reader: file not found: ${args.jsonl}\n`)
    process.exit(2)
  }

  const size = statSync(args.jsonl).size
  const end = Math.min(size, Math.max(0, args.upperOffset ?? size))
  const requestedStart = args.offset ?? 0
  const fellBack = requestedStart > end
  const start = fellBack ? 0 : requestedStart
  const baseCount = fellBack ? 0 : args.messageCount
  const messages = scan(args.jsonl, start, end)
  const parsedAt = new Date().toISOString()
  const progress = {
    offset: end,
    lastEntryUuid: '',
    messageCount: baseCount + messages.length,
    parsedAt,
  }
  const common = {
    progress,
    fellBack,
    reason: fellBack ? 'truncation' : args.offset === undefined ? 'first-time' : null,
    deltaCount: messages.length,
  }
  if (args.format === 'snapshot') process.stdout.write(JSON.stringify(common))
  else if (args.format === 'json') process.stdout.write(JSON.stringify({ ...common, messages }))
  else process.stdout.write(JSON.stringify({ ...common, markdownDelta: render(messages, args.batch, parsedAt, fellBack) }))
}

main()
