import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readDelta } from '../src/capture/jsonl-reader.js'
import type { ParseProgress } from '../src/capture/types.js'

function makeEntry(opts: {
  uuid: string
  type: string
  parentUuid?: string | null
  role?: 'user' | 'assistant'
  text?: string
  thinking?: string
  toolUse?: boolean
  isSidechain?: boolean
  timestamp?: string
}): string {
  const entry: Record<string, unknown> = {
    parentUuid: opts.parentUuid ?? null,
    uuid: opts.uuid,
    type: opts.type,
    timestamp: opts.timestamp ?? '2026-05-25T10:00:00Z',
    sessionId: 'test-session',
    isSidechain: opts.isSidechain ?? false,
  }
  if (opts.role) {
    if (opts.type === 'user' && typeof opts.text === 'string' && !opts.thinking && !opts.toolUse) {
      entry.message = { role: opts.role, content: opts.text }
    } else {
      const content: Array<Record<string, unknown>> = []
      if (opts.thinking) content.push({ type: 'thinking', thinking: opts.thinking, signature: 'sig' })
      if (opts.text !== undefined) content.push({ type: 'text', text: opts.text })
      if (opts.toolUse) content.push({ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } })
      entry.message = { role: opts.role, content }
    }
  }
  return JSON.stringify(entry) + '\n'
}

describe('readDelta', () => {
  let tempDir: string
  let jsonlPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-jsonl-reader-'))
    jsonlPath = join(tempDir, 'session.jsonl')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('first-time scan returns all user/assistant messages', () => {
    const content =
      makeEntry({ uuid: 'a1', type: 'attachment' }) +
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'hello' }) +
      makeEntry({ uuid: 'a2', type: 'assistant', role: 'assistant', text: 'hi back' })
    writeFileSync(jsonlPath, content)

    const delta = readDelta(jsonlPath, null)

    expect(delta.fellBack).toBe(false)
    expect(delta.reason).toBe('first-time')
    expect(delta.messages.map(m => m.content)).toEqual(['hello', 'hi back'])
    expect(delta.newOffset).toBe(statSync(jsonlPath).size)
    expect(delta.newEntryUuid).toBe('a2')
    expect(delta.newMessageCount).toBe(2)
  })

  it('skips sidechain entries', () => {
    const content =
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'main' }) +
      makeEntry({ uuid: 'u2', type: 'user', role: 'user', text: 'sub', isSidechain: true })
    writeFileSync(jsonlPath, content)

    const delta = readDelta(jsonlPath, null)
    expect(delta.messages.map(m => m.content)).toEqual(['main'])
  })

  it('skips non-user/assistant entries', () => {
    const content =
      makeEntry({ uuid: 'p1', type: 'permission-mode' }) +
      makeEntry({ uuid: 'a1', type: 'attachment' }) +
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'real msg' })
    writeFileSync(jsonlPath, content)

    const delta = readDelta(jsonlPath, null)
    expect(delta.messages).toHaveLength(1)
    expect(delta.messages[0].content).toBe('real msg')
  })

  it('extracts only text parts from assistant array content (skips thinking/tool_use)', () => {
    const content = makeEntry({
      uuid: 'a1', type: 'assistant', role: 'assistant',
      thinking: 'internal reasoning', text: 'visible reply', toolUse: true,
    })
    writeFileSync(jsonlPath, content)

    const delta = readDelta(jsonlPath, null)
    expect(delta.messages).toHaveLength(1)
    expect(delta.messages[0].content).toBe('visible reply')
    expect(delta.messages[0].content).not.toContain('internal reasoning')
  })

  it('incremental: with valid prior, returns only new messages', () => {
    const initial =
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'first' }) +
      makeEntry({ uuid: 'a1', type: 'assistant', role: 'assistant', text: 'reply 1' })
    writeFileSync(jsonlPath, initial)
    const firstPass = readDelta(jsonlPath, null)
    expect(firstPass.messages).toHaveLength(2)

    const prior: ParseProgress = {
      offset: firstPass.newOffset,
      lastEntryUuid: firstPass.newEntryUuid,
      messageCount: firstPass.newMessageCount,
      parsedAt: '2026-05-25T10:00:00Z',
    }

    appendFileSync(jsonlPath, makeEntry({ uuid: 'u2', type: 'user', role: 'user', text: 'second' }))
    const delta = readDelta(jsonlPath, prior)

    expect(delta.fellBack).toBe(false)
    expect(delta.messages.map(m => m.content)).toEqual(['second'])
    expect(delta.newMessageCount).toBe(3)
    expect(delta.newEntryUuid).toBe('u2')
  })

  it('no-change: prior.offset === fileSize and sentinel valid → empty delta', () => {
    const content =
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'only msg' })
    writeFileSync(jsonlPath, content)
    const first = readDelta(jsonlPath, null)

    const prior: ParseProgress = {
      offset: first.newOffset,
      lastEntryUuid: first.newEntryUuid,
      messageCount: first.newMessageCount,
      parsedAt: '2026-05-25T10:00:00Z',
    }
    const delta = readDelta(jsonlPath, prior)

    expect(delta.fellBack).toBe(false)
    expect(delta.messages).toHaveLength(0)
    expect(delta.newOffset).toBe(prior.offset)
    expect(delta.newMessageCount).toBe(prior.messageCount)
  })

  it('truncation: fileSize < prior.offset → full scan with fellBack=true', () => {
    const original =
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'a' }) +
      makeEntry({ uuid: 'u2', type: 'user', role: 'user', text: 'b' }) +
      makeEntry({ uuid: 'u3', type: 'user', role: 'user', text: 'c' })
    writeFileSync(jsonlPath, original)
    const fullSize = statSync(jsonlPath).size

    const prior: ParseProgress = {
      offset: fullSize,
      lastEntryUuid: 'u3',
      messageCount: 3,
      parsedAt: '2026-05-25T10:00:00Z',
    }

    // truncate
    writeFileSync(jsonlPath, makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'a' }))
    const delta = readDelta(jsonlPath, prior)

    expect(delta.fellBack).toBe(true)
    expect(delta.reason).toBe('truncation')
    expect(delta.messages.map(m => m.content)).toEqual(['a'])
    expect(delta.newMessageCount).toBe(1)
  })

  it('compaction: sentinel uuid not found → full scan with fellBack=true', () => {
    const original =
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'a' }) +
      makeEntry({ uuid: 'u2', type: 'user', role: 'user', text: 'b' })
    writeFileSync(jsonlPath, original)
    const firstSize = statSync(jsonlPath).size

    // Simulate compaction: rewrite with entirely different uuids
    const compacted =
      makeEntry({ uuid: 'summary1', type: 'user', role: 'user', text: 'summary of a + b' }) +
      makeEntry({ uuid: 'new1', type: 'user', role: 'user', text: 'new msg' })
    writeFileSync(jsonlPath, compacted)

    const prior: ParseProgress = {
      offset: firstSize,
      lastEntryUuid: 'u2',
      messageCount: 2,
      parsedAt: '2026-05-25T10:00:00Z',
    }
    // Append a bit more so fileSize > prior.offset but uuid is gone
    appendFileSync(jsonlPath, makeEntry({ uuid: 'new2', type: 'user', role: 'user', text: 'after compact' }))

    const delta = readDelta(jsonlPath, prior)

    expect(delta.fellBack).toBe(true)
    expect(delta.reason).toBe('sentinel-not-found')
    expect(delta.messages.map(m => m.content)).toEqual(['summary of a + b', 'new msg', 'after compact'])
    expect(delta.newMessageCount).toBe(3)
  })

  it('empty file → no messages', () => {
    writeFileSync(jsonlPath, '')
    const delta = readDelta(jsonlPath, null)
    expect(delta.messages).toHaveLength(0)
    expect(delta.newOffset).toBe(0)
    expect(delta.newMessageCount).toBe(0)
  })

  it('handles user content as plain string', () => {
    const content = makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'plain string msg' })
    writeFileSync(jsonlPath, content)
    const delta = readDelta(jsonlPath, null)
    expect(delta.messages[0].content).toBe('plain string msg')
  })

  it('records uuid even from non-message entries (last sentinel)', () => {
    const content =
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'msg' }) +
      makeEntry({ uuid: 'attach-last', type: 'attachment' })
    writeFileSync(jsonlPath, content)

    const delta = readDelta(jsonlPath, null)
    expect(delta.messages).toHaveLength(1)
    expect(delta.newEntryUuid).toBe('attach-last')
  })

  it('upperBound caps the scan (snapshot enforcement)', () => {
    const content =
      makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'first' }) +
      makeEntry({ uuid: 'u2', type: 'user', role: 'user', text: 'second' }) +
      makeEntry({ uuid: 'u3', type: 'user', role: 'user', text: 'third' })
    writeFileSync(jsonlPath, content)
    const fullSize = statSync(jsonlPath).size

    // Capture snapshot at boundary after second message
    const firstEntryLen = Buffer.byteLength(makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'first' }), 'utf-8')
    const secondEntryLen = Buffer.byteLength(makeEntry({ uuid: 'u2', type: 'user', role: 'user', text: 'second' }), 'utf-8')
    const snapshotBound = firstEntryLen + secondEntryLen
    expect(snapshotBound).toBeLessThan(fullSize)

    const delta = readDelta(jsonlPath, null, { upperBound: snapshotBound })

    expect(delta.fellBack).toBe(false)
    expect(delta.messages.map(m => m.content)).toEqual(['first', 'second'])
    expect(delta.newOffset).toBe(snapshotBound)
    expect(delta.newMessageCount).toBe(2)
  })

  it('upperBound + prior: delta only between prior.offset and upperBound', () => {
    const e1 = makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'a' })
    const e2 = makeEntry({ uuid: 'u2', type: 'user', role: 'user', text: 'b' })
    const e3 = makeEntry({ uuid: 'u3', type: 'user', role: 'user', text: 'c' })
    writeFileSync(jsonlPath, e1 + e2 + e3)

    const first = readDelta(jsonlPath, null, { upperBound: Buffer.byteLength(e1, 'utf-8') })
    const prior: ParseProgress = {
      offset: first.newOffset,
      lastEntryUuid: first.newEntryUuid,
      messageCount: first.newMessageCount,
      parsedAt: '2026-05-25T10:00:00Z',
    }
    expect(first.messages.map(m => m.content)).toEqual(['a'])

    const upperBound = Buffer.byteLength(e1 + e2, 'utf-8')
    const delta = readDelta(jsonlPath, prior, { upperBound })

    expect(delta.fellBack).toBe(false)
    expect(delta.messages.map(m => m.content)).toEqual(['b'])
    expect(delta.newOffset).toBe(upperBound)
    expect(delta.newMessageCount).toBe(2)
  })

  it('upperBound > fileSize is clamped to fileSize', () => {
    const content = makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'only' })
    writeFileSync(jsonlPath, content)
    const fullSize = statSync(jsonlPath).size

    const delta = readDelta(jsonlPath, null, { upperBound: fullSize * 10 })
    expect(delta.messages.map(m => m.content)).toEqual(['only'])
    expect(delta.newOffset).toBe(fullSize)
  })

  it('incremental after attachment-only growth: zero new messages, offset advances', () => {
    const initial = makeEntry({ uuid: 'u1', type: 'user', role: 'user', text: 'msg' })
    writeFileSync(jsonlPath, initial)
    const first = readDelta(jsonlPath, null)

    const prior: ParseProgress = {
      offset: first.newOffset,
      lastEntryUuid: first.newEntryUuid,
      messageCount: first.newMessageCount,
      parsedAt: '2026-05-25T10:00:00Z',
    }

    appendFileSync(jsonlPath, makeEntry({ uuid: 'attach1', type: 'attachment' }))
    const delta = readDelta(jsonlPath, prior)

    expect(delta.fellBack).toBe(false)
    expect(delta.messages).toHaveLength(0)
    expect(delta.newOffset).toBeGreaterThan(prior.offset)
    expect(delta.newEntryUuid).toBe('attach1')
    expect(delta.newMessageCount).toBe(1)
  })
})
