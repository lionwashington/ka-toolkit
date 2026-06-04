import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { handleStopEvent } from '../src/hooks/capture-hook.js'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('capture-hook (Stop event)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-hook-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('saves conversation from transcript_path', async () => {
    // Write a JSONL transcript file matching Claude Code's actual format
    const transcriptPath = join(tempDir, 'transcript.jsonl')
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Ran 5km today' },
        timestamp: '2026-04-07T14:00:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Great! Keep it up' }] },
        timestamp: '2026-04-07T14:00:05Z',
      }),
    ]
    writeFileSync(transcriptPath, lines.join('\n'), 'utf-8')

    const hookInput = {
      session_id: 'session-abc',
      cwd: '/some/project',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    }

    await handleStopEvent(hookInput, join(tempDir, 'conversations'))

    const files = readdirSync(join(tempDir, 'conversations'))
    expect(files).toHaveLength(1)

    const content = readFileSync(join(tempDir, 'conversations', files[0]), 'utf-8')
    expect(content).toContain('source: claude-code')
    expect(content).toContain('Ran 5km today')
    expect(content).toContain('Great! Keep it up')
  })

  it('skips when no transcript_path and no messages', async () => {
    const hookInput = {
      session_id: 'session-abc',
      cwd: '/some/project',
      hook_event_name: 'Stop',
    }

    await handleStopEvent(hookInput, join(tempDir, 'conversations'))

    const { existsSync } = await import('fs')
    const convDir = join(tempDir, 'conversations')
    if (existsSync(convDir)) {
      const files = readdirSync(convDir)
      expect(files).toHaveLength(0)
    }
  })

  it('skips non-message entries in transcript', async () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl')
    const lines = [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: '2026-04-07T14:00:00Z',
      }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools' } }),
    ]
    writeFileSync(transcriptPath, lines.join('\n'), 'utf-8')

    const hookInput = {
      session_id: 'session-abc',
      cwd: '/some/project',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
    }

    await handleStopEvent(hookInput, join(tempDir, 'conversations'))

    const files = readdirSync(join(tempDir, 'conversations'))
    expect(files).toHaveLength(1)

    const content = readFileSync(join(tempDir, 'conversations', files[0]), 'utf-8')
    expect(content).toContain('Hello')
    // Should only have 1 message (the user message), not permission-mode or attachment
  })
})
