import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '@ka/core'
import { parseCodexRollout } from '../src/rollout.js'
import { handleCodexStopEvent } from '../src/hooks/capture-hook.js'

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ka-codex-capture-'))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture(path: string): void {
  const records = [
    { timestamp: '2026-07-19T01:00:00Z', type: 'session_meta', payload: { id: 'session-1', cwd: '/workspace' } },
    { timestamp: '2026-07-19T01:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Previous question' } },
    { timestamp: '2026-07-19T01:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-07-19T01:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'First question' } },
    { timestamp: '2026-07-19T01:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
    { timestamp: '2026-07-19T01:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: 'First answer', phase: 'final_answer' } },
    { timestamp: '2026-07-19T01:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { timestamp: '2026-07-19T01:00:05Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { timestamp: '2026-07-19T01:00:06Z', type: 'event_msg', payload: { type: 'user_message', message: 'Next question' } },
  ]
  const lines = records.map(record => JSON.stringify(record))
  lines.splice(4, 0, '{broken')
  writeFileSync(path, lines.join('\n') + '\n')
}

describe('parseCodexRollout', () => {
  it('extracts visible user and agent messages without duplicating response items', () => {
    const root = tempRoot()
    const rollout = join(root, 'rollout.jsonl')
    fixture(rollout)
    const parsed = parseCodexRollout(rollout, 'turn-1')
    expect(parsed.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'First question'],
      ['assistant', 'First answer'],
    ])
    expect(parsed.malformedLines).toBe(1)
  })

  it('returns an empty result for a missing rollout', () => {
    expect(parseCodexRollout('/missing/rollout.jsonl')).toMatchObject({
      messages: [], malformedLines: 0, bytesRead: 0, reason: 'missing',
    })
  })

  it('reads only the active tail turn from a large historical rollout', () => {
    const root = tempRoot()
    const rollout = join(root, 'large-rollout.jsonl')
    writeFileSync(rollout, '')
    truncateSync(rollout, 96 * 1024 * 1024)
    const records = [
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'previous-turn' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'active-turn' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Tail question' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Tail answer' } },
    ]
    appendFileSync(rollout, `\n${records.map(record => JSON.stringify(record)).join('\n')}\n`)

    const parsed = parseCodexRollout(rollout, 'active-turn')
    expect(statSync(rollout).size).toBeGreaterThan(96 * 1024 * 1024)
    expect(parsed.messages.map(message => message.content)).toEqual(['Tail question', 'Tail answer'])
    expect(parsed.bytesRead).toBeLessThan(256 * 1024)
    expect(parsed.startOffset).toBeGreaterThanOrEqual(96 * 1024 * 1024)
    expect(parsed.reason).toBeNull()
  })

  it('keeps all continuations that reuse the same turn id', () => {
    const root = tempRoot()
    const rollout = join(root, 'continued-rollout.jsonl')
    const records = [
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'previous-turn' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'continued-turn' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Initial question' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Initial answer' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'continued-turn' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Stop continuation' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Final answer' } },
    ]
    writeFileSync(rollout, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)

    expect(parseCodexRollout(rollout, 'continued-turn').messages.map(message => message.content)).toEqual([
      'Initial question', 'Initial answer', 'Stop continuation', 'Final answer',
    ])
  })

  it('fails closed instead of falling back to a full scan when the turn is outside the lookback', () => {
    const root = tempRoot()
    const rollout = join(root, 'bounded-rollout.jsonl')
    writeFileSync(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } })}\n`)
    appendFileSync(rollout, `${'x'.repeat(2 * 1024 * 1024)}\n`)
    const parsed = parseCodexRollout(rollout, 'old-turn', { maxLookbackBytes: 1024 * 1024 })
    expect(parsed.messages).toEqual([])
    expect(parsed.reason).toBe('turn-not-found')
    expect(parsed.bytesRead).toBe(1024 * 1024)
  })
})

describe('Codex Stop capture', () => {
  it('writes source, session metadata, and visible messages to raw markdown', async () => {
    const root = tempRoot()
    const rollout = join(root, 'rollout.jsonl')
    const rawDir = join(root, 'raw')
    fixture(rollout)
    expect(await handleCodexStopEvent({
      session_id: 'session-1',
      transcript_path: rollout,
      cwd: '/workspace',
      hook_event_name: 'Stop',
      model: 'test-model',
      turn_id: 'turn-1',
    }, rawDir)).toBe(true)
    expect(await handleCodexStopEvent({
      session_id: 'session-1',
      transcript_path: rollout,
      cwd: '/workspace',
      hook_event_name: 'Stop',
      model: 'test-model',
      turn_id: 'turn-1',
    }, rawDir)).toBe(true)
    const files = (await import('node:fs')).readdirSync(rawDir)
    expect(files).toHaveLength(1)
    const saved = parseFrontmatter(readFileSync(join(rawDir, files[0]), 'utf8'))
    expect(saved.data.source).toBe('codex')
    expect(saved.data.session_id).toBe('session-1:turn-1')
    expect(Number(saved.data.metadata.rollout_bytes_read)).toBeLessThan(statSync(rollout).size * 3)
    expect(saved.content).toContain('First question')
    expect(saved.content).toContain('First answer')
  })

  it('skips when the hook has no transcript', async () => {
    const root = tempRoot()
    expect(await handleCodexStopEvent({
      session_id: 'session-1',
      transcript_path: null,
      cwd: '/workspace',
      hook_event_name: 'Stop',
    }, join(root, 'raw'))).toBe(false)
  })
})
