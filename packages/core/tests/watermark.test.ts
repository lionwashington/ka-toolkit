import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WatermarkStore } from '../src/watermark/watermark.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('WatermarkStore', () => {
  let tempDir: string
  let store: WatermarkStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-wm-'))
    store = new WatermarkStore(join(tempDir, 'state'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('returns null for unknown session', () => {
    const wm = store.get('claude-code', 'session-1')
    expect(wm).toBeNull()
  })

  it('saves and retrieves watermark', () => {
    store.set('claude-code', 'session-1', {
      lastConversationId: 'conv-123',
      lastTimestamp: '2026-04-07T15:00:00+08:00',
    })

    const wm = store.get('claude-code', 'session-1')
    expect(wm).not.toBeNull()
    expect(wm!.lastConversationId).toBe('conv-123')
  })

  it('updates existing watermark', () => {
    store.set('claude-code', 'session-1', {
      lastConversationId: 'conv-1',
      lastTimestamp: '2026-04-07T14:00:00+08:00',
    })
    store.set('claude-code', 'session-1', {
      lastConversationId: 'conv-2',
      lastTimestamp: '2026-04-07T15:00:00+08:00',
    })

    const wm = store.get('claude-code', 'session-1')
    expect(wm!.lastConversationId).toBe('conv-2')
  })

  it('tracks multiple sessions independently', () => {
    store.set('claude-code', 'session-1', {
      lastConversationId: 'conv-a',
      lastTimestamp: '2026-04-07T14:00:00+08:00',
    })
    store.set('claude-code', 'session-2', {
      lastConversationId: 'conv-b',
      lastTimestamp: '2026-04-07T15:00:00+08:00',
    })

    expect(store.get('claude-code', 'session-1')!.lastConversationId).toBe('conv-a')
    expect(store.get('claude-code', 'session-2')!.lastConversationId).toBe('conv-b')
  })
})
