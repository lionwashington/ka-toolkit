import { existsSync, readFileSync } from 'node:fs'
import type { ConversationMessage } from '@ka/core'

interface RolloutRecord {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    message?: unknown
    phase?: string
    turn_id?: string
  }
}

export interface CodexRollout {
  messages: ConversationMessage[]
  malformedLines: number
}

/**
 * Parse the stable, user-visible subset observed in Codex rollout JSONL.
 * The transcript itself is explicitly documented as unstable, so unknown
 * records and payload variants are ignored instead of becoming fatal.
 */
export function parseCodexRollout(path: string, turnId?: string): CodexRollout {
  if (!existsSync(path)) return { messages: [], malformedLines: 0 }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { messages: [], malformedLines: 0 }
  }

  const messages: ConversationMessage[] = []
  let malformedLines = 0
  let inRequestedTurn = turnId === undefined
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let record: RolloutRecord
    try {
      record = JSON.parse(line) as RolloutRecord
    } catch {
      malformedLines++
      continue
    }
    if (record.type === 'event_msg' && record.payload?.type === 'task_started') {
      if (record.payload.turn_id === turnId) inRequestedTurn = true
      continue
    }
    if (record.type === 'event_msg' && record.payload?.type === 'task_complete') {
      if (record.payload.turn_id === turnId) break
      continue
    }
    if (!inRequestedTurn) continue
    if (record.type !== 'event_msg') continue
    const payloadType = record.payload?.type
    if (payloadType !== 'user_message' && payloadType !== 'agent_message') continue
    if (typeof record.payload?.message !== 'string' || !record.payload.message.trim()) continue
    messages.push({
      role: payloadType === 'user_message' ? 'user' : 'assistant',
      content: record.payload.message,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
    })
  }
  return { messages, malformedLines }
}
