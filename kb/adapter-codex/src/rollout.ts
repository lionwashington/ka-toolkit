import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type { ConversationMessage } from '@ka/core'

const TAIL_READ_CHUNK = 64 * 1024
const FORWARD_READ_CHUNK = 1024 * 1024
const DEFAULT_MAX_LOOKBACK = 64 * 1024 * 1024

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
  startOffset: number
  endOffset: number
  bytesRead: number
  reason: null | 'missing' | 'turn-not-found'
}

export interface CodexRolloutOptions {
  maxLookbackBytes?: number
}

interface TurnStart {
  offset: number
  bytesRead: number
}

function parseRecord(line: Buffer): RolloutRecord | null {
  const trimmed = line.toString('utf8').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as RolloutRecord
  } catch {
    return null
  }
}

/**
 * Locate the active turn from the end of the append-only rollout. Stop hooks
 * always run at the tail, so reading historical turns is unnecessary. Keep
 * walking a little beyond the matching task_started record to handle a Stop
 * continuation that reuses the same turn id.
 */
function findTurnStart(
  fd: number,
  endOffset: number,
  turnId: string | undefined,
  maxLookbackBytes: number,
): TurnStart | null {
  const lowerBound = Math.max(0, endOffset - maxLookbackBytes)
  let cursor = endOffset
  let carry = Buffer.alloc(0)
  let bytesRead = 0
  let foundOffset: number | undefined

  while (cursor > lowerBound) {
    const start = Math.max(lowerBound, cursor - TAIL_READ_CHUNK)
    const buffer = Buffer.allocUnsafe(cursor - start)
    const count = readSync(fd, buffer, 0, buffer.length, start)
    if (count === 0) break
    bytesRead += count
    const combined = carry.length
      ? Buffer.concat([buffer.subarray(0, count), carry])
      : buffer.subarray(0, count)

    const lineStarts = [0]
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === 0x0a && i + 1 < combined.length) lineStarts.push(i + 1)
    }
    const firstComplete = start === 0 ? 0 : 1
    for (let i = lineStarts.length - 1; i >= firstComplete; i--) {
      const lineStart = lineStarts[i]
      let lineEnd = i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : combined.length
      if (lineEnd > lineStart && combined[lineEnd - 1] === 0x0d) lineEnd--
      const record = parseRecord(combined.subarray(lineStart, lineEnd))
      const payload = record?.payload
      if (record?.type === 'event_msg' && payload?.type === 'task_started') {
        if (turnId === undefined) return { offset: start + lineStart, bytesRead }
        if (payload.turn_id === turnId) {
          foundOffset = start + lineStart
          continue
        }
        if (foundOffset !== undefined) return { offset: foundOffset, bytesRead }
      }
      if (record?.type === 'event_msg' && payload?.type === 'task_complete' &&
          foundOffset !== undefined && payload.turn_id !== turnId) {
        return { offset: foundOffset, bytesRead }
      }
    }

    const firstNewline = combined.indexOf(0x0a)
    carry = firstNewline === -1
      ? Buffer.from(combined)
      : Buffer.from(combined.subarray(0, firstNewline))
    cursor = start
  }

  return foundOffset === undefined ? null : { offset: foundOffset, bytesRead }
}

function scanTurn(
  fd: number,
  startOffset: number,
  endOffset: number,
  turnId: string | undefined,
): { messages: ConversationMessage[]; malformedLines: number; bytesRead: number } {
  const messages: ConversationMessage[] = []
  let malformedLines = 0
  let bytesRead = 0
  let position = startOffset
  let leftover = Buffer.alloc(0)
  let done = false
  let sawStart = false

  const consume = (line: Buffer): void => {
    const trimmed = line.toString('utf8').trim()
    if (!trimmed) return
    let record: RolloutRecord
    try {
      record = JSON.parse(trimmed) as RolloutRecord
    } catch {
      malformedLines++
      return
    }
    const payload = record.payload
    if (record.type === 'event_msg' && payload?.type === 'task_started') {
      if (sawStart && turnId !== undefined && payload.turn_id !== turnId) done = true
      sawStart = true
      return
    }
    if (record.type === 'event_msg' && payload?.type === 'task_complete') {
      if (turnId === undefined || payload.turn_id === turnId) done = true
      return
    }
    if (record.type !== 'event_msg' || done) return
    if (payload?.type !== 'user_message' && payload?.type !== 'agent_message') return
    if (typeof payload.message !== 'string' || !payload.message.trim()) return
    messages.push({
      role: payload.type === 'user_message' ? 'user' : 'assistant',
      content: payload.message,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
    })
  }

  while (position < endOffset && !done) {
    const length = Math.min(FORWARD_READ_CHUNK, endOffset - position)
    const buffer = Buffer.allocUnsafe(length)
    const count = readSync(fd, buffer, 0, length, position)
    if (count === 0) break
    bytesRead += count
    const combined = leftover.length
      ? Buffer.concat([leftover, buffer.subarray(0, count)])
      : buffer.subarray(0, count)
    let lineStart = 0
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] !== 0x0a) continue
      consume(combined.subarray(lineStart, i))
      lineStart = i + 1
      if (done) break
    }
    leftover = done ? Buffer.alloc(0) : Buffer.from(combined.subarray(lineStart))
    position += count
  }
  if (!done && leftover.length) consume(leftover)
  return { messages, malformedLines, bytesRead }
}

/**
 * Parse only the requested Codex turn. The rollout is snapshotted at stat.size
 * so records appended while the hook runs are left for a later invocation.
 */
export function parseCodexRollout(
  path: string,
  turnId?: string,
  options: CodexRolloutOptions = {},
): CodexRollout {
  if (!existsSync(path)) {
    return { messages: [], malformedLines: 0, startOffset: 0, endOffset: 0, bytesRead: 0, reason: 'missing' }
  }
  const endOffset = statSync(path).size
  const maxLookbackBytes = Math.max(TAIL_READ_CHUNK, options.maxLookbackBytes ?? DEFAULT_MAX_LOOKBACK)
  const fd = openSync(path, 'r')
  try {
    const start = findTurnStart(fd, endOffset, turnId, maxLookbackBytes)
    if (!start) {
      return {
        messages: [], malformedLines: 0, startOffset: endOffset, endOffset,
        bytesRead: Math.min(endOffset, maxLookbackBytes), reason: 'turn-not-found',
      }
    }
    const parsed = scanTurn(fd, start.offset, endOffset, turnId)
    return {
      ...parsed,
      startOffset: start.offset,
      endOffset,
      bytesRead: start.bytesRead + parsed.bytesRead,
      reason: null,
    }
  } finally {
    closeSync(fd)
  }
}
