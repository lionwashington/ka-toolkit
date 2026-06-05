import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanceEngine, type ChunkRow, type EngineEmbedder } from './lance-engine.js'
import { segment } from './segmenter.js'

// Fake embedder — no model load. Maps a query to a 3-dim "topic" vector.
const fakeEmbedder: EngineEmbedder = {
  async embedQuery(q: string) {
    if (/NAT|clash|网|梯子/i.test(q)) return [1, 0, 0]
    if (/跑步|心率/.test(q)) return [0, 1, 0]
    return [0, 0, 1]
  },
}

const row = (o: Partial<ChunkRow>): ChunkRow => ({
  id: o.id!, path: o.path!, topic: o.topic!, kind: o.kind ?? 'parent',
  parent: o.parent ?? o.path!, title: o.title ?? '', heading: o.heading ?? '',
  chunk_index: o.chunk_index ?? 0, text: o.text!, text_seg: o.text_seg ?? segment(o.text!),
  vector: o.vector!, updated: o.updated ?? '2026-06-01',
})

const ROWS: ChunkRow[] = [
  row({ id: 'n0', path: 'topics/tech-network.md', topic: 'tech-network', heading: 'TUN 与 NAT',
        text: 'Clash TUN 模式与 NAT 类型检测、光猫桥接配置', vector: [1, 0, 0] }),
  row({ id: 'n1', path: 'topics/tech-network.md', topic: 'tech-network', heading: 'BT 上传',
        text: 'BitTorrent choking 影响上传', vector: [0.8, 0.1, 0] }),
  row({ id: 'r0', path: 'topics/health-cardio.md', topic: 'health-cardio',
        text: '跑步 Zone2 配速 心率 有氧', vector: [0, 1, 0] }),
  row({ id: 'f0', path: 'topics/finance.md', topic: 'finance',
        text: 'IBKR 投资仓位 ETF 现金', vector: [0, 0, 1] }),
  // a daily-log chunk that mentions NAT — must NOT out-rank the real topic (down-weighted).
  row({ id: 'l0', path: 'conversations/2026-06-05.md', topic: 'conv-2026-06-05', kind: 'conversation',
        text: '今天 TL;DR：聊了 NAT 和会议纪要', vector: [0.95, 0, 0] }),
]

let engine: LanceEngine
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lance-engine-'))
  engine = new LanceEngine(join(dir, 'db'), fakeEmbedder)
  await engine.rebuild(ROWS)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('LanceEngine hybrid search', () => {
  it('vector + FTS hybrid ranks the right topic top-1 for a colloquial query', async () => {
    const hits = await engine.search('网怎么又连不上了梯子 Clash NAT', 3)
    expect(hits[0].topic).toBe('tech-network')
  })

  it('down-weights conversation/log chunks below topic files (NAT log does not win)', async () => {
    const hits = await engine.search('NAT', 5)
    const net = hits.findIndex((h) => h.topic === 'tech-network')
    const log = hits.findIndex((h) => h.topic === 'conv-2026-06-05')
    expect(net).toBeGreaterThanOrEqual(0)
    expect(net).toBeLessThan(log === -1 ? Infinity : log) // network ranks above the log
  })

  it('dedupes to topic level — one hit per topic, not multiple chunks of one file', async () => {
    const hits = await engine.search('Clash NAT', 5)
    const topics = hits.map((h) => h.topic)
    expect(new Set(topics).size).toBe(topics.length)
  })

  it('returns the matched chunk text as the excerpt + topk respected', async () => {
    const hits = await engine.search('Clash NAT', 2)
    expect(hits.length).toBeLessThanOrEqual(2)
    expect(hits[0].text).toContain('NAT')
  })
})
