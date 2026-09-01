import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCaptureChannelAllowed, loadConfig, parseFrontmatter, serializeWithFrontmatter } from '@ka/core'
import type { Conversation } from '@ka/core'
import { parseCodexRollout } from '../rollout.js'

export interface CodexStopHookInput {
  session_id: string
  transcript_path?: string | null
  cwd: string
  hook_event_name: string
  model?: string
  turn_id?: string
}

function saveCodexTurn(conversation: Conversation, rawDir: string): void {
  mkdirSync(rawDir, { recursive: true })
  const filePath = join(rawDir, `${conversation.timestamp.slice(0, 10)}-${conversation.id}.md`)
  let distilled = false
  let topics: unknown[] = []
  if (existsSync(filePath)) {
    try {
      const existing = parseFrontmatter(readFileSync(filePath, 'utf8')).data
      distilled = existing.distilled === true
      topics = Array.isArray(existing.topics) ? existing.topics : []
    } catch { /* replace an unreadable per-turn capture */ }
  }
  const frontmatter: Record<string, unknown> = {
    id: conversation.id,
    source: conversation.source,
    session_id: conversation.sessionId,
    timestamp: conversation.timestamp,
    distilled,
    topics,
    metadata: conversation.metadata ?? {},
  }
  const body = conversation.messages
    .map(message => `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content}`)
    .join('\n\n')
  const temporary = `${filePath}.tmp-${process.pid}`
  writeFileSync(temporary, serializeWithFrontmatter(frontmatter, body), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, filePath)
}

export async function handleCodexStopEvent(input: CodexStopHookInput, rawDir: string): Promise<boolean> {
  if (!input.transcript_path) return false
  const parsed = parseCodexRollout(input.transcript_path, input.turn_id)
  if (parsed.messages.length === 0) {
    if (parsed.reason) console.error(`[ka] codex capture skipped: ${parsed.reason}`)
    return false
  }
  const now = new Date().toISOString()
  const captureKey = `${input.session_id}:${input.turn_id ?? parsed.startOffset}`
  const conversation: Conversation = {
    id: createHash('sha256').update(captureKey).digest('hex').slice(0, 12),
    source: 'codex',
    sessionId: captureKey,
    timestamp: parsed.messages[0]?.timestamp || now,
    messages: parsed.messages.map(message => ({ ...message, timestamp: message.timestamp || now })),
    metadata: {
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      codex_session_id: input.session_id,
      codex_turn_id: input.turn_id,
      malformed_lines: parsed.malformedLines,
      rollout_start_offset: parsed.startOffset,
      rollout_end_offset: parsed.endOffset,
      rollout_bytes_read: parsed.bytesRead,
    },
  }
  // The path is derived from the turn key, so save/update is O(1). The generic
  // capture dedupe scans raw/ by session id, which is unsuitable for a Stop hook.
  saveCodexTurn(conversation, rawDir)
  return true
}

async function main(): Promise<void> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk.toString()
  try {
    const input = JSON.parse(data) as CodexStopHookInput
    const config = loadConfig()
    if (existsSync(join(config.state_dir, 'paused'))) return
    if (!isCaptureChannelAllowed(process.env.KA_CHANNEL, config)) return
    await handleCodexStopEvent(input, join(config.knowledge_base_path, 'raw'))
  } catch (error) {
    console.error('[ka] codex capture hook error:', error)
  } finally {
    // Codex Stop hooks expect JSON on stdout for a successful exit.
    process.stdout.write('{}\n')
  }
}

if (process.argv[1]?.includes('capture-hook')) void main()
