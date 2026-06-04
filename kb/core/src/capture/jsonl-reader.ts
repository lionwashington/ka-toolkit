import { statSync, openSync, readSync, closeSync } from 'fs'
import type { ConversationMessage, JsonlDelta, JsonlEntry, ParseProgress } from './types.js'

const READ_CHUNK = 1024 * 1024
const VALIDATION_CHUNK = 256 * 1024
const VALIDATION_MAX_BACK = 2 * 1024 * 1024

export interface ReadDeltaOptions {
  /**
   * Hard upper bound on bytes to scan. Used by background distill to enforce
   * a snapshot: messages added to the jsonl after this byte are ignored and
   * left for the next run. When unset, the full current file size is used.
   */
  upperBound?: number
}

export function readDelta(jsonlPath: string, prior: ParseProgress | null, opts: ReadDeltaOptions = {}): JsonlDelta {
  const stat = statSync(jsonlPath)
  const fileSize = opts.upperBound !== undefined
    ? Math.min(stat.size, Math.max(0, opts.upperBound))
    : stat.size

  if (!prior) {
    return scanRange(jsonlPath, 0, fileSize, 0, false, 'first-time')
  }

  if (fileSize < prior.offset) {
    return scanRange(jsonlPath, 0, fileSize, 0, true, 'truncation')
  }

  if (fileSize === prior.offset) {
    return {
      messages: [],
      newOffset: prior.offset,
      newEntryUuid: prior.lastEntryUuid,
      newMessageCount: prior.messageCount,
      fellBack: false,
      reason: null,
    }
  }

  if (!validateSentinel(jsonlPath, prior)) {
    return scanRange(jsonlPath, 0, fileSize, 0, true, 'sentinel-not-found')
  }

  return scanRange(jsonlPath, prior.offset, fileSize, prior.messageCount, false, null, prior.lastEntryUuid)
}

function scanRange(
  jsonlPath: string,
  startOffset: number,
  endOffset: number,
  baseMessageCount: number,
  fellBack: boolean,
  reason: string | null,
  priorUuid: string = '',
): JsonlDelta {
  const messages: ConversationMessage[] = []
  let lastUuid = priorUuid
  let leftover = ''
  let pos = startOffset

  if (endOffset <= startOffset) {
    return {
      messages,
      newOffset: endOffset,
      newEntryUuid: lastUuid,
      newMessageCount: baseMessageCount,
      fellBack,
      reason,
    }
  }

  const fd = openSync(jsonlPath, 'r')
  try {
    while (pos < endOffset) {
      const readLen = Math.min(READ_CHUNK, endOffset - pos)
      const buf = Buffer.alloc(readLen)
      const bytesRead = readSync(fd, buf, 0, readLen, pos)
      if (bytesRead === 0) break
      const text = leftover + buf.toString('utf-8', 0, bytesRead)
      const lines = text.split('\n')
      leftover = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const entry = tryParse(trimmed)
        if (!entry) continue
        if (entry.uuid) lastUuid = entry.uuid
        const msg = extractMessage(entry)
        if (msg) messages.push(msg)
      }
      pos += bytesRead
    }
    if (leftover.trim()) {
      const entry = tryParse(leftover.trim())
      if (entry) {
        if (entry.uuid) lastUuid = entry.uuid
        const msg = extractMessage(entry)
        if (msg) messages.push(msg)
      }
    }
  } finally {
    closeSync(fd)
  }

  return {
    messages,
    newOffset: endOffset,
    newEntryUuid: lastUuid,
    newMessageCount: baseMessageCount + messages.length,
    fellBack,
    reason,
  }
}

function validateSentinel(jsonlPath: string, prior: ParseProgress): boolean {
  if (prior.offset === 0) return prior.lastEntryUuid === ''
  if (!prior.lastEntryUuid) return false

  const fd = openSync(jsonlPath, 'r')
  try {
    let backStart = prior.offset
    let leftover = ''
    while (backStart > 0 && prior.offset - backStart < VALIDATION_MAX_BACK) {
      const readStart = Math.max(0, backStart - VALIDATION_CHUNK)
      const readLen = backStart - readStart
      const buf = Buffer.alloc(readLen)
      const bytesRead = readSync(fd, buf, 0, readLen, readStart)
      const text = buf.toString('utf-8', 0, bytesRead) + leftover
      const lines = text.split('\n')
      const partial = readStart > 0 ? lines.shift() ?? '' : ''
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim()
        if (!trimmed) continue
        const entry = tryParse(trimmed)
        if (entry?.uuid === prior.lastEntryUuid) return true
      }
      leftover = partial
      backStart = readStart
    }
    if (leftover.trim()) {
      const entry = tryParse(leftover.trim())
      if (entry?.uuid === prior.lastEntryUuid) return true
    }
  } finally {
    closeSync(fd)
  }
  return false
}

function tryParse(line: string): JsonlEntry | null {
  try {
    return JSON.parse(line) as JsonlEntry
  } catch {
    return null
  }
}

function extractMessage(entry: JsonlEntry): ConversationMessage | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  if (entry.isSidechain) return null
  if (!entry.message) return null
  const role = entry.message.role
  if (role !== 'user' && role !== 'assistant') return null
  const content = stringifyContent(entry.message.content)
  if (!content) return null
  return {
    role,
    content,
    timestamp: entry.timestamp ?? '',
    uuid: entry.uuid,
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: string }
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
      }
    }
    return parts.join('\n').trim()
  }
  return ''
}
