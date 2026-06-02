import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Distiller } from '../src/distiller/distiller.js'
import { KnowledgeStore } from '../src/knowledge-store/store.js'
import { ConversationCapture } from '../src/capture/capture.js'
import { WatermarkStore } from '../src/watermark/watermark.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Distiller', () => {
  let tempDir: string
  let store: KnowledgeStore
  let capture: ConversationCapture
  let watermarks: WatermarkStore
  let distiller: Distiller

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-distill-'))
    store = new KnowledgeStore(tempDir)
    store.init()
    store.writeTopic({
      name: 'health', description: 'exercise and diet',
      created: '2026-04-07', updated: '2026-04-07', tags: ['health'], content: '',
    })
    capture = new ConversationCapture(join(tempDir, 'conversations'))
    watermarks = new WatermarkStore(join(tempDir, 'state'))
    distiller = new Distiller(store, capture, watermarks)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  describe('generatePrompt', () => {
    it('returns null when no unprocessed conversations', () => {
      expect(distiller.generatePrompt()).toBeNull()
    })

    it('generates prompt with conversation content and known topics', () => {
      capture.save({
        id: 'conv-1', source: 'claude-code', sessionId: 's1',
        timestamp: '2026-04-07T14:00:00+08:00',
        messages: [
          { role: 'user', content: 'Ran 5km today', timestamp: '2026-04-07T14:00:00+08:00' },
          { role: 'assistant', content: 'Great!', timestamp: '2026-04-07T14:00:05+08:00' },
        ],
      })

      const result = distiller.generatePrompt()

      expect(result).not.toBeNull()
      expect(result!.prompt).toContain('Ran 5km today')
      expect(result!.prompt).toContain('health')
      expect(result!.conversationIds).toEqual(['conv-1'])
      expect(result!.knownTopics).toContain('health')
    })

    it('includes compact summary when provided', () => {
      capture.save({
        id: 'conv-1', source: 'claude-code', sessionId: 's1',
        timestamp: '2026-04-07T14:00:00+08:00',
        messages: [{ role: 'user', content: 'test', timestamp: '2026-04-07T14:00:00+08:00' }],
      })

      const result = distiller.generatePrompt('User discussed running habits')

      expect(result!.prompt).toContain('User discussed running habits')
      expect(result!.prompt).toContain('compact summary')
    })
  })

  describe('processResult', () => {
    it('processes extractions into existing topics', () => {
      capture.save({
        id: 'conv-1', source: 'claude-code', sessionId: 's1',
        timestamp: '2026-04-07T14:00:00+08:00',
        messages: [{ role: 'user', content: 'test', timestamp: '2026-04-07T14:00:00+08:00' }],
      })

      const response = JSON.stringify({
        extractions: [{
          topicName: 'health', isNew: false,
          content: '## Running Log\nRan 5km today',
          tags: ['exercise'], sourceConversationId: 'conv-1',
        }],
      })

      const result = distiller.processResult(response, ['conv-1'])

      expect(result.processedConversations).toBe(1)
      expect(result.updatedTopics).toContain('health')
      expect(store.readTopic('health').content).toContain('Running Log')
    })

    it('collects new topic suggestions', () => {
      const response = JSON.stringify({
        extractions: [{
          topicName: 'travel', isNew: true,
          description: 'travel plans', content: '## Japan\nVisiting Tokyo next year',
          tags: ['travel'], sourceConversationId: 'conv-1',
        }],
      })

      const result = distiller.processResult(response, ['conv-1'])

      expect(result.suggestedTopics).toHaveLength(1)
      expect(result.suggestedTopics[0].name).toBe('travel')
    })

    it('handles invalid JSON gracefully', () => {
      const result = distiller.processResult('not json', ['conv-1'])
      expect(result.processedConversations).toBe(0)
    })

    it('marks conversations as distilled', () => {
      capture.save({
        id: 'conv-1', source: 'claude-code', sessionId: 's1',
        timestamp: '2026-04-07T14:00:00+08:00',
        messages: [{ role: 'user', content: 'test', timestamp: '2026-04-07T14:00:00+08:00' }],
      })

      distiller.processResult(JSON.stringify({ extractions: [] }), ['conv-1'])

      expect(capture.getUnprocessed()).toHaveLength(0)
    })
  })
})
