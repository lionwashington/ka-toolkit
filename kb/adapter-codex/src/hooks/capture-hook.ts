import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicUpdateText, isCaptureChannelAllowed, loadConfig, parseFrontmatter, serializeWithFrontmatter } from '@ka/core'
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
  atomicUpdateText(filePath, previous => {
    let distilled = false
    let topics: unknown[] = []
    let distilledMessageCount = 0
    const body = conversation.messages
      .map(message => `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content}`)
      .join('\n\n')
    const contentHash = createHash('sha256').update(body.trim()).digest('hex')
    if (previous !== null) {
      try {
        const parsed = parseFrontmatter(previous)
        const existing = parsed.data
        const oldHash = createHash('sha256').update(parsed.content.trim()).digest('hex')
        if (oldHash === contentHash) return null
        // A slower, older hook must not overwrite a newer rollout snapshot.
        if (Number((existing.metadata as Record<string, unknown>)?.rollout_end_offset ?? 0) > Number(conversation.metadata?.rollout_end_offset ?? 0)) return null
        if (body.trim().startsWith(parsed.content.trim() + '\n')) {
          distilledMessageCount = existing.distilled === true
            ? parsed.content.split(/^## (User|Assistant)$/m).slice(1).length / 2
            : Number(existing.distilled_message_count ?? 0)
        }
        // A later capture can add a continuation to an already distilled turn.
        // The changed snapshot must become eligible for processing again.
        distilled = false
        topics = Array.isArray(existing.topics) ? existing.topics : []
      } catch { throw new Error('refusing to replace unreadable Codex capture') }
    }
    const frontmatter: Record<string, unknown> = {
      id: conversation.id,
      source: conversation.source,
      session_id: conversation.sessionId,
      timestamp: conversation.timestamp,
      distilled,
      topics,
      content_hash: contentHash,
      distilled_message_count: distilledMessageCount,
      metadata: conversation.metadata ?? {},
    }
    return serializeWithFrontmatter(frontmatter, body)
  })
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
