import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Fts5Engine } from './fts5-engine.js'
import type { TextChunkRow } from './types.js'

const row = (id: string, topic: string, text: string, heading = ''): TextChunkRow => ({
  id,
  path: `topics/${topic}.md`,
  topic,
  kind: 'parent',
  parent: `topics/${topic}.md`,
  title: topic,
  heading,
  chunk_index: Number(id.replace(/\D/g, '')) || 0,
  text,
  text_seg: '',
  updated: '2026-07-23',
})

describe('Fts5Engine', () => {
  let dir: string
  let engine: Fts5Engine

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ka-fts5-'))
    engine = new Fts5Engine(join(dir, 'kb.sqlite'))
    engine.rebuild([
      row('n0', 'hk-transit', '沙田 to 中环 interchange guide', '港铁路线'),
      row('n1', 'hk-transit', '旺角 station exit and transfer notes'),
      row('r0', 'hk-districts', '屯门 元朗 district boundary reference'),
      row('f0', 'sample-catalog', 'alpha beta gamma catalog entry'),
    ])
  })

  afterEach(() => {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds Chinese and Latin terms through Intl-segmented FTS5', () => {
    expect(engine.search('沙田 中环', 3)[0]?.topic).toBe('hk-transit')
    expect(engine.search('屯门元朗', 3)[0]?.topic).toBe('hk-districts')
  })

  it('handles FTS punctuation as plain user text', () => {
    expect(engine.search('station: (exit) "transfer"', 3)[0]?.topic).toBe('hk-transit')
  })

  it('dedupes multiple chunks to one topic', () => {
    const hits = engine.search('station 沙田 旺角', 5)
    const topics = hits.map((hit) => hit.topic)
    expect(new Set(topics).size).toBe(topics.length)
  })

  it('upserts changed paths and removes vanished paths', () => {
    engine.upsert(
      [row('r1', 'hk-districts', '大埔 北区 district reference')],
      { removedPaths: ['topics/sample-catalog.md'], sourceMtimeMax: 42 },
    )
    expect(engine.search('大埔', 3)[0]?.topic).toBe('hk-districts')
    expect(engine.search('alpha', 3)).toEqual([])
    expect(engine.status()?.source_mtime_max).toBe(42)
  })
})
