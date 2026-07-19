import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConversationCapture, isCaptureChannelAllowed, loadConfig } from '@ka/core'
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

export async function handleCodexStopEvent(input: CodexStopHookInput, rawDir: string): Promise<boolean> {
  if (!input.transcript_path) return false
  const parsed = parseCodexRollout(input.transcript_path, input.turn_id)
  if (parsed.messages.length === 0) return false
  const now = new Date().toISOString()
  const conversation: Conversation = {
    id: randomBytes(6).toString('hex'),
    source: 'codex',
    sessionId: input.turn_id ? `${input.session_id}:${input.turn_id}` : input.session_id,
    timestamp: parsed.messages[0]?.timestamp || now,
    messages: parsed.messages.map(message => ({ ...message, timestamp: message.timestamp || now })),
    metadata: {
      cwd: input.cwd,
      model: input.model,
      codex_session_id: input.session_id,
      codex_turn_id: input.turn_id,
      malformed_lines: parsed.malformedLines,
    },
  }
  new ConversationCapture(rawDir).save(conversation)
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
  }
}

if (process.argv[1]?.includes('capture-hook')) void main()
