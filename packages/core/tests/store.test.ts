import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KnowledgeStore } from '../src/knowledge-store/store.js'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('KnowledgeStore', () => {
  let tempDir: string
  let store: KnowledgeStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-store-'))
    store = new KnowledgeStore(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  describe('init', () => {
    it('creates knowledge base directory structure', () => {
      store.init()
      const indexContent = readFileSync(join(tempDir, 'INDEX.md'), 'utf-8')
      expect(indexContent).toContain('# Knowledge Base Index')
    })
  })

  describe('topics', () => {
    it('writes and reads a topic', () => {
      store.init()
      store.writeTopic({
        name: 'health',
        description: 'exercise and diet',
        created: '2026-04-07',
        updated: '2026-04-07',
        tags: ['health', 'exercise'],
        content: '## Exercise Habits\nRun 3 times a week',
      })

      const topic = store.readTopic('health')

      expect(topic.name).toBe('health')
      expect(topic.tags).toEqual(['health', 'exercise'])
      expect(topic.content).toContain('Run 3 times a week')
    })

    it('lists all topics', () => {
      store.init()
      store.writeTopic({ name: 'health', description: 'exercise and diet', created: '2026-04-07', updated: '2026-04-07', tags: [], content: '' })
      store.writeTopic({ name: 'career', description: 'career planning', created: '2026-04-07', updated: '2026-04-07', tags: [], content: '' })

      const topics = store.listTopics()

      expect(topics).toHaveLength(2)
      expect(topics.map(t => t.name)).toContain('health')
      expect(topics.map(t => t.name)).toContain('career')
    })

    it('appends content to existing topic', () => {
      store.init()
      store.writeTopic({ name: 'health', description: 'exercise and diet', created: '2026-04-07', updated: '2026-04-07', tags: ['health'], content: '## Exercise\nRunning' })

      store.appendToTopic('health', '\n\n## Diet\nLow fat, low salt', ['diet'])

      const topic = store.readTopic('health')
      expect(topic.content).toContain('## Exercise')
      expect(topic.content).toContain('## Diet')
      expect(topic.tags).toContain('diet')
    })
  })

  describe('updateIndex', () => {
    it('updates INDEX.md to match topics and triggers RAG reindex', () => {
      store.init()
      store.writeTopic({ name: 'health', description: 'exercise and diet', created: '2026-04-07', updated: '2026-04-07', tags: [], content: '' })
      store.updateIndex()

      const indexContent = readFileSync(join(tempDir, 'INDEX.md'), 'utf-8')
      expect(indexContent).toContain('health')
      expect(indexContent).toContain('exercise and diet')
    })
  })

  describe('init', () => {
    it('creates raw directory', () => {
      store.init()
      const { existsSync } = require('fs')
      expect(existsSync(join(tempDir, 'raw'))).toBe(true)
    })
  })
})
