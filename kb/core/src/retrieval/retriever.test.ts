import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRetriever, LanceRetriever } from './retriever.js'
import { LanceEngine } from './lance-engine.js'
import { reindex } from './indexer.js'

const fakeEmbedder = {
  model: 'fake',
  async embedDocuments(texts: string[]) { return texts.map(() => [1, 0, 0]) },
  async embedQuery() { return [1, 0, 0] },
}

let kb: string
let dbDir: string
beforeAll(async () => {
  kb = mkdtempSync(join(tmpdir(), 'kb-retriever-'))
  mkdirSync(join(kb, 'topics'), { recursive: true })
  writeFileSync(join(kb, 'topics', 'sample-net.md'),
    `---\ntitle: 网络\n---\n\n## NAT\nClash NAT 桥接配置。\n`)
  dbDir = join(kb, 'db')
  await reindex(new LanceEngine(dbDir, fakeEmbedder), kb, fakeEmbedder)
})
afterAll(() => rmSync(kb, { recursive: true, force: true }))

describe('createRetriever', () => {
  it('defaults to fts5 and accepts embedding as the configured mode', () => {
    expect(createRetriever(kb, {})).toBeInstanceOf(LanceRetriever)
    expect(createRetriever(kb, {}, { embedder: fakeEmbedder as any })).toBeInstanceOf(LanceRetriever)
    expect(createRetriever(kb, {}).defaultMode).toBe('fts5')
    expect(createRetriever(kb, { retrieval: { mode: 'embedding' } }).defaultMode).toBe('embedding')
  })
})

describe('LanceRetriever.search → SearchResult shape (signatures unchanged)', () => {
  it('maps engine hits to {path,title,excerpt,score,type}', async () => {
    const r = new LanceRetriever(kb, fakeEmbedder as any, dbDir, 'embedding')
    const res = await r.search('Clash NAT', { maxResults: 5 })
    expect(res.length).toBeGreaterThan(0)
    const hit = res[0]
    expect(hit.path).toBe('topics/sample-net.md')
    expect(hit.type).toBe('topic')
    expect(typeof hit.score).toBe('number')
    expect(hit.excerpt).toContain('NAT')
    expect(hit.title).toBe('网络')
  })

  it('returns [] gracefully when the index has not been built', async () => {
    const r = new LanceRetriever(kb, fakeEmbedder as any, join(kb, 'nonexistent-db'), 'embedding')
    expect(await r.search('anything')).toEqual([])
  })

  it('supports explicit fts5 mode without invoking the embedder', async () => {
    const noEmbed = {
      model: 'must-not-run',
      async embedDocuments() { throw new Error('embedding should not run') },
      async embedQuery() { throw new Error('embedding should not run') },
    }
    const ftsDb = join(kb, 'fts5', 'kb.sqlite')
    const r = new LanceRetriever(kb, noEmbed as any, dbDir, 'fts5', ftsDb)
    await r.reindex({ full: true, mode: 'fts5' })
    const res = await r.search('Clash NAT', { mode: 'fts5' })
    expect(res[0]?.path).toBe('topics/sample-net.md')
  })
})
