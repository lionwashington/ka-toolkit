import { ConversationCapture } from '@ka/core'
import type { Conversation } from '@ka/core'
import { randomBytes } from 'crypto'
import { loadConfig, isCaptureChannelAllowed } from '@ka/core'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

interface StopHookInput {
  session_id: string
  cwd: string
  hook_event_name: string
  transcript_path?: string
  [key: string]: unknown
}

interface ParsedMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text' && c.text)
      .map((c: any) => c.text)
      .join('\n')
  }
  return ''
}

function loadTranscript(transcriptPath: string): ParsedMessage[] {
  if (!existsSync(transcriptPath)) return []
  try {
    const raw = readFileSync(transcriptPath, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const messages: ParsedMessage[] = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        // Claude Code JSONL: message entries have type "user" or "assistant"
        // with the actual message in entry.message.{role, content}
        if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
          const text = extractTextContent(entry.message.content)
          if (text.trim()) {
            messages.push({
              role: entry.message.role ?? entry.type,
              content: text,
              timestamp: entry.timestamp ?? new Date().toISOString(),
            })
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    return messages
  } catch {
    return []
  }
}

export async function handleStopEvent(
  input: StopHookInput,
  conversationsDir: string,
): Promise<void> {
  // Primary: read from transcript file (most reliable)
  let messages: ParsedMessage[] = []
  if (input.transcript_path) {
    messages = loadTranscript(input.transcript_path)
  }

  if (messages.length === 0) {
    console.error('[ka] Stop hook: no conversation data found, skipping')
    return
  }

  const now = new Date().toISOString()
  const id = randomBytes(6).toString('hex')

  const conversation: Conversation = {
    id,
    source: 'claude-code',
    sessionId: input.session_id,
    timestamp: messages[0]?.timestamp ?? now,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
    metadata: { cwd: input.cwd },
  }

  const capture = new ConversationCapture(conversationsDir)
  capture.save(conversation)
  console.error(`[ka] Captured conversation ${id} (${messages.length} messages)`)
}

// CLI entry: reads hook input from stdin
const isDirectRun = process.argv[1]?.includes('capture-hook')
if (isDirectRun) {
  let data = ''
  process.stdin.on('data', (chunk: Buffer) => { data += chunk.toString() })
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(data) as StopHookInput
      const config = loadConfig()

      // Check pause flag first
      const pausedPath = join(config.state_dir, 'paused')
      if (existsSync(pausedPath)) {
        console.error('[ka] Capture paused, skipping')
        return
      }

      // Channel whitelist (fail-closed): only capture channels listed in
      // channels.capture. Empty/missing config → capture nothing. Mates' and
      // out-of-workshop sessions' intermediate work is skipped.
      if (!isCaptureChannelAllowed(process.env.KA_CHANNEL, config)) {
        console.error(`[ka] Capture skipped: channel '${process.env.KA_CHANNEL ?? ''}' not in channels.capture`)
        return
      }

      // Debug: dump hook input (only when not paused)
      if (process.env.KA_DEBUG) {
        const debugPath = join(config.state_dir, 'last-stop-hook-input.json')
        mkdirSync(dirname(debugPath), { recursive: true })
        writeFileSync(debugPath, JSON.stringify(input, null, 2), 'utf-8')
      }

      const rawDir = join(config.knowledge_base_path, 'raw')
      await handleStopEvent(input, rawDir)
    } catch (err) {
      console.error('[ka] capture-hook error:', err)
      // Exit 0 to avoid disrupting Claude Code session
    }
  })
}
