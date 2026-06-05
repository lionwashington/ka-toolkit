import { describe, it, expect } from 'vitest'
import { chunkTopic } from './chunker.js'

const TOPIC = `---
title: tech-network
description: 网络配置总览
tags: [topic]
---

跨领域总览：Clash、DNS、路由器的整体配置思路。

## TUN 模式与 NAT
Clash TUN 模式开启后，NAT 类型检测会变化。光猫桥接配置说明在这里。

## BT 与上传
BitTorrent choking 算法影响上传速度。

<!-- sub-topic-index: managed by ka-split-topic — do NOT edit manually -->
## Sub-Topic Index
- [[topics/tech-network-dns|DNS 分流]]
`

describe('chunkTopic', () => {
  it('splits by ## headings, keeps the pre-heading intro as its own chunk', () => {
    const chunks = chunkTopic(TOPIC, { topic: 'tech-network' })
    const headings = chunks.map((c) => c.heading)
    expect(headings).toContain('')               // intro chunk
    expect(headings).toContain('TUN 模式与 NAT')
    expect(headings).toContain('BT 与上传')
  })

  it('excludes the auto-generated Sub-Topic Index section', () => {
    const chunks = chunkTopic(TOPIC, { topic: 'tech-network' })
    expect(chunks.some((c) => c.heading.includes('Sub-Topic Index'))).toBe(false)
    expect(chunks.some((c) => c.text.includes('tech-network-dns'))).toBe(false)
  })

  it('prepends "topic › heading" context to embedText (not to raw text)', () => {
    const chunks = chunkTopic(TOPIC, { topic: 'tech-network' })
    const tun = chunks.find((c) => c.heading === 'TUN 模式与 NAT')!
    expect(tun.embedText.startsWith('tech-network › TUN 模式与 NAT')).toBe(true)
    expect(tun.text).toContain('NAT 类型检测')
    expect(tun.text.startsWith('tech-network ›')).toBe(false) // raw text is clean
  })

  it('assigns sequential chunk_index and keeps real content', () => {
    const chunks = chunkTopic(TOPIC, { topic: 'tech-network' })
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
    expect(chunks.find((c) => c.heading === 'TUN 模式与 NAT')!.text).toContain('光猫桥接')
  })

  it('sub-splits an over-budget section into multiple chunks with overlap', () => {
    const big =
      `---\ntitle: t\n---\n\n## 大段\n` +
      Array.from({ length: 40 }, (_, i) => `第${i}段。这是一段比较长的中文内容用于测试切分预算。`).join('\n\n')
    const chunks = chunkTopic(big, { topic: 't', maxTokens: 120 })
    const bigChunks = chunks.filter((c) => c.heading === '大段')
    expect(bigChunks.length).toBeGreaterThan(1)
  })

  it('returns [] for an empty / frontmatter-only doc', () => {
    expect(chunkTopic(`---\ntitle: x\n---\n`, { topic: 'x' })).toEqual([])
  })
})
