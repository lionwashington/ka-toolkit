import { existsSync } from 'fs'
import { readDelta } from './jsonl-reader.js'
import type { ParseProgress } from './types.js'

interface CliArgs {
  jsonl: string
  offset?: number
  lastEntryUuid?: string
  messageCount?: number
  upperOffset?: number
  format: 'json' | 'markdown-json' | 'snapshot'
  batch: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { format: 'markdown-json', batch: 1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`flag ${a} requires value`)
      return v
    }
    switch (a) {
      case '--jsonl': args.jsonl = next(); break
      case '--offset': args.offset = Number(next()); break
      case '--last-entry-uuid': args.lastEntryUuid = next(); break
      case '--message-count': args.messageCount = Number(next()); break
      case '--upper-offset': args.upperOffset = Number(next()); break
      case '--format': args.format = next() as CliArgs['format']; break
      case '--batch': args.batch = Number(next()); break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`unknown flag: ${a}`)
    }
  }
  if (!args.jsonl) throw new Error('--jsonl is required')
  return args as CliArgs
}

function printHelp(): void {
  process.stdout.write(`Usage: ka-jsonl-reader --jsonl <path> [options]

Options:
  --jsonl <path>             Required. Path to Claude Code session .jsonl
  --offset <bytes>           Prior parse offset (skip if absent → first-time scan)
  --last-entry-uuid <uuid>   Prior last entry uuid (sentinel for validation)
  --message-count <n>        Prior cumulative message count (default 0)
  --upper-offset <bytes>     Hard cap on bytes to scan (snapshot enforcement
                             for background distill — ignores anything after).
  --format <fmt>             Output format: json | markdown-json | snapshot
                             (default markdown-json). 'snapshot' = progress
                             fields only (no messages/markdown — cheap for the
                             distill-bg snapshot capture).
  --batch <n>                Batch number to embed in separator comment (default 1)

Output (markdown-json): JSON object {
  progress: { offset, lastEntryUuid, messageCount, parsedAt },
  markdownDelta: string,   // ready-to-append markdown body (with batch separator)
  fellBack: boolean,
  reason: string | null,
  deltaCount: number
}

Exit codes: 0 success | 1 input error | 2 file error
`)
}

function main(): void {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`ka-jsonl-reader: ${(e as Error).message}\n`)
    process.exit(1)
  }

  if (!existsSync(args.jsonl)) {
    process.stderr.write(`ka-jsonl-reader: file not found: ${args.jsonl}\n`)
    process.exit(2)
  }

  const prior: ParseProgress | null = (args.offset !== undefined)
    ? {
        offset: args.offset,
        lastEntryUuid: args.lastEntryUuid ?? '',
        messageCount: args.messageCount ?? 0,
        parsedAt: '',
      }
    : null

  const delta = readDelta(args.jsonl, prior, args.upperOffset !== undefined ? { upperBound: args.upperOffset } : {})
  const parsedAt = new Date().toISOString()
  const progress = {
    offset: delta.newOffset,
    lastEntryUuid: delta.newEntryUuid,
    messageCount: delta.newMessageCount,
    parsedAt,
  }

  if (args.format === 'snapshot') {
    process.stdout.write(JSON.stringify({
      progress,
      fellBack: delta.fellBack,
      reason: delta.reason,
      deltaCount: delta.messages.length,
    }))
    return
  }

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify({
      progress,
      messages: delta.messages,
      fellBack: delta.fellBack,
      reason: delta.reason,
      deltaCount: delta.messages.length,
    }))
    return
  }

  // markdown-json (default)
  const markdownDelta = renderMarkdown(delta.messages, args.batch, parsedAt, delta.fellBack)
  process.stdout.write(JSON.stringify({
    progress,
    markdownDelta,
    fellBack: delta.fellBack,
    reason: delta.reason,
    deltaCount: delta.messages.length,
  }))
}

function renderMarkdown(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  batch: number,
  parsedAt: string,
  fellBack: boolean,
): string {
  if (messages.length === 0) return ''
  const header = fellBack
    ? `<!-- batch ${batch} @ ${parsedAt} (full re-scan after fallback) -->`
    : `<!-- batch ${batch} @ ${parsedAt} -->`
  const body = messages
    .map(m => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`)
    .join('\n\n')
  return `${header}\n\n${body}`
}

main()
