import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildChunkRows, type IndexerEmbedder } from './indexer.js'

const fakeEmbedder: IndexerEmbedder = {
  model: 'fake',
  async embedDocuments(texts) { return texts.map(() => [1, 0, 0]) },
}

let kb: string
beforeAll(() => {
  kb = mkdtempSync(join(tmpdir(), 'kb-indexer-'))
  mkdirSync(join(kb, 'topics'), { recursive: true })
  mkdirSync(join(kb, 'conversations'), { recursive: true })
  writeFileSync(join(kb, 'topics', 'tech-network.md'),
    `---\ntitle: 网络\ntags: [topic]\n---\n\n总览段。\n\n## TUN 与 NAT\nClash TUN 模式与 NAT 类型检测。\n`)
  writeFileSync(join(kb, 'topics', 'tech-network-dns.md'),
    `---\ntitle: DNS 分流\nparent: tech-network.md\nsub_topic: dns\n---\n\n## DNS 规则\nGeoSite 与 GeoIP 分流。\n`)
  writeFileSync(join(kb, 'conversations', '2026-06-05.md'),
    `---\ndate: 2026-06-05\n---\n\n## 今天\nTL;DR 聊了 NAT。\n`)
})
afterAll(() => rmSync(kb, { recursive: true, force: true }))

describe('buildChunkRows', () => {
  it('chunks topics + conversations and tags kind (parent / sub / conversation)', async () => {
    const { rows, docCount } = await buildChunkRows(kb, fakeEmbedder)
    expect(docCount).toBe(3)
    const byTopic = (t: string) => rows.filter((r) => r.topic === t)
    expect(byTopic('tech-network').every((r) => r.kind === 'parent')).toBe(true)
    const dns = byTopic('tech-network-dns')
    expect(dns.length).toBeGreaterThan(0)
    expect(dns[0].kind).toBe('sub')
    expect(dns[0].parent).toBe('topics/tech-network.md')
    expect(byTopic('2026-06-05')[0].kind).toBe('conversation')
  })

  it('segments the Chinese text_seg column and assigns a vector to each chunk', async () => {
    const { rows } = await buildChunkRows(kb, fakeEmbedder)
    const nat = rows.find((r) => r.heading === 'TUN 与 NAT')!
    expect(nat.text_seg).toContain(' ')        // segmented → spaces between tokens
    expect(nat.text).toContain('NAT')          // raw text preserved
    expect(rows.every((r) => Array.isArray(r.vector) && r.vector.length === 3)).toBe(true)
    expect(nat.id).toBe('topics/tech-network.md#1') // intro=#0, TUN/NAT=#1
  })

  it('records sourceMtimeMax from the files', async () => {
    const { rows, sourceMtimeMax } = await buildChunkRows(kb, fakeEmbedder)
    expect(sourceMtimeMax).toBeGreaterThan(0)
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })
})
