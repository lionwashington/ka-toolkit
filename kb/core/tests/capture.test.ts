import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ConversationCapture } from '../src/capture/capture.js'
import type { Conversation } from '../src/capture/types.js'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('ConversationCapture', () => {
  let tempDir: string
  let capture: ConversationCapture

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-capture-'))
    capture = new ConversationCapture(join(tempDir, 'conversations'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('saves a conversation as Markdown', () => {
    const conv: Conversation = {
      id: 'test-123',
      source: 'claude-code',
      sessionId: 'session-abc',
      timestamp: '2026-04-07T14:30:00+08:00',
      messages: [
        { role: 'user', content: 'Ran 5km today', timestamp: '2026-04-07T14:30:00+08:00' },
        { role: 'assistant', content: 'Great! Keep it up', timestamp: '2026-04-07T14:30:05+08:00' },
      ],
    }

    capture.save(conv)

    const files = readdirSync(join(tempDir, 'conversations'))
    expect(files).toHaveLength(1)

    const content = readFileSync(join(tempDir, 'conversations', files[0]), 'utf-8')
    expect(content).toContain('id: test-123')
    expect(content).toContain('source: claude-code')
    expect(content).toContain('Ran 5km today')
    expect(content).toContain('Great! Keep it up')
  })

  it('retrieves unprocessed conversations', () => {
    const conv1: Conversation = {
      id: 'conv-1', source: 'claude-code', sessionId: 's1',
      timestamp: '2026-04-07T14:00:00+08:00',
      messages: [{ role: 'user', content: 'hello', timestamp: '2026-04-07T14:00:00+08:00' }],
    }
    const conv2: Conversation = {
      id: 'conv-2', source: 'claude-code', sessionId: 's2',
      timestamp: '2026-04-07T15:00:00+08:00',
      messages: [{ role: 'user', content: 'world', timestamp: '2026-04-07T15:00:00+08:00' }],
    }

    capture.save(conv1)
    capture.save(conv2)

    const unprocessed = capture.getUnprocessed()
    expect(unprocessed).toHaveLength(2)
  })

  it('deduplicates by sessionId — overwrites existing conversation', () => {
    const conv1: Conversation = {
      id: 'conv-1', source: 'claude-code', sessionId: 'same-session',
      timestamp: '2026-04-07T14:00:00+08:00',
      messages: [{ role: 'user', content: 'first version', timestamp: '2026-04-07T14:00:00+08:00' }],
    }
    const conv2: Conversation = {
      id: 'conv-2', source: 'claude-code', sessionId: 'same-session',
      timestamp: '2026-04-07T15:00:00+08:00',
      messages: [
        { role: 'user', content: 'first version', timestamp: '2026-04-07T14:00:00+08:00' },
        { role: 'user', content: 'second message', timestamp: '2026-04-07T15:00:00+08:00' },
      ],
    }

    capture.save(conv1)
    capture.save(conv2)

    const files = readdirSync(join(tempDir, 'conversations'))
    expect(files).toHaveLength(1)

    const content = readFileSync(join(tempDir, 'conversations', files[0]), 'utf-8')
    expect(content).toContain('second message')
    // Should keep original id
    expect(content).toContain('id: conv-1')
  })

  it('marks conversation as distilled', () => {
    const conv: Conversation = {
      id: 'conv-1', source: 'claude-code', sessionId: 's1',
      timestamp: '2026-04-07T14:00:00+08:00',
      messages: [{ role: 'user', content: 'test', timestamp: '2026-04-07T14:00:00+08:00' }],
    }

    capture.save(conv)
    capture.markDistilled('conv-1', ['health'])

    const unprocessed = capture.getUnprocessed()
    expect(unprocessed).toHaveLength(0)

    const content = readFileSync(join(tempDir, 'conversations', '2026-04-07-conv-1.md'), 'utf-8')
    expect(content).toContain('distilled: true')
    expect(content).toContain('health')
  })
})
