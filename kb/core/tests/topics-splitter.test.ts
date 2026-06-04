import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { splitTopic, type SplitPlan } from '../src/topics/splitter.js'
import { parseFrontmatter } from '../src/knowledge-store/markdown.js'

function makeTopic(name: string, preamble: string, sections: Array<{ h: string; body: string }>): string {
  const fm = `---
title: ${name} topic
tags:
  - topic
---

`
  const head = preamble ? preamble + '\n\n' : ''
  const body = sections.map(s => `## ${s.h}\n\n${s.body}`).join('\n\n')
  return fm + head + body + '\n'
}

describe('splitTopic', () => {
  let tempDir: string
  let topicPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-topics-split-'))
    topicPath = join(tempDir, 'finance.md')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('moves sections per plan; hub keeps unmentioned sections + preamble', () => {
    writeFileSync(topicPath, makeTopic('finance', 'this is the intro preamble', [
      { h: 'NVDA 涨', body: 'nvda content' },
      { h: '工资 $21K', body: 'salary content' },
      { h: 'hkprop 屯门', body: 'hkprop content' },
      { h: '月度 budget', body: 'cross-cutting' },
    ]), 'utf-8')

    const plan: SplitPlan = {
      subTopics: [
        { name: 'investment', title: '投资', description: 'IBKR + 美股', headings: ['## NVDA 涨'] },
        { name: 'income', title: '收入', headings: ['## 工资 $21K'] },
        { name: 'property', title: '房产', headings: ['## hkprop 屯门'] },
      ],
    }

    const result = splitTopic(topicPath, plan)

    expect(result.subTopicsWritten).toHaveLength(3)
    expect(result.unmovedHeadings).toEqual(['## 月度 budget'])

    const hub = readFileSync(topicPath, 'utf-8')
    expect(hub).toContain('this is the intro preamble')
    expect(hub).toContain('## 月度 budget')
    expect(hub).toContain('cross-cutting')
    expect(hub).not.toContain('nvda content')
    expect(hub).not.toContain('salary content')
    expect(hub).not.toContain('hkprop content')
    expect(hub).toContain('## Sub-Topic Index')
    expect(hub).toContain('[[finance-investment]]')
    expect(hub).toContain('[[finance-income]]')
    expect(hub).toContain('[[finance-property]]')

    // Hub frontmatter has the sub_topics array
    const { data } = parseFrontmatter(hub)
    expect(Array.isArray(data.sub_topics)).toBe(true)
    expect((data.sub_topics as Array<{ name: string }>).map(x => x.name)).toEqual(['investment', 'income', 'property'])

    const inv = readFileSync(join(tempDir, 'finance-investment.md'), 'utf-8')
    expect(inv).toContain('← [[finance]]')
    expect(inv).toContain('## NVDA 涨')
    expect(inv).toContain('nvda content')
    const { data: invFm } = parseFrontmatter(inv)
    expect(invFm.parent).toBe('finance.md')
    expect(invFm.sub_topic).toBe('investment')
    expect(invFm.title).toBe('投资')
  })

  it('throws on heading not present in topic file', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [
      { h: 'A', body: 'a' },
      { h: 'B', body: 'b' },
    ]), 'utf-8')

    const plan: SplitPlan = {
      subTopics: [
        { name: 'x', title: 'x', headings: ['## A', '## DOES NOT EXIST'] },
      ],
    }
    expect(() => splitTopic(topicPath, plan)).toThrow(/DOES NOT EXIST/)
  })

  it('throws when the same heading appears in multiple sub-topics', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [{ h: 'shared', body: 's' }]), 'utf-8')
    const plan: SplitPlan = {
      subTopics: [
        { name: 'a', title: 'A', headings: ['## shared'] },
        { name: 'b', title: 'B', headings: ['## shared'] },
      ],
    }
    expect(() => splitTopic(topicPath, plan)).toThrow(/multiple sub-topics/)
  })

  it('throws when target sub-topic file already exists (default — no force)', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [{ h: 'X', body: 'x' }]), 'utf-8')
    writeFileSync(join(tempDir, 'finance-x.md'), 'old content', 'utf-8')
    const plan: SplitPlan = { subTopics: [{ name: 'x', title: 'X', headings: ['## X'] }] }
    expect(() => splitTopic(topicPath, plan)).toThrow(/already exist/)
  })

  it('with force:true overwrites existing sub-topic file', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [{ h: 'X', body: 'fresh' }]), 'utf-8')
    writeFileSync(join(tempDir, 'finance-x.md'), 'old content', 'utf-8')
    const plan: SplitPlan = { subTopics: [{ name: 'x', title: 'X', headings: ['## X'] }] }
    const r = splitTopic(topicPath, plan, { force: true })
    expect(r.subTopicsWritten).toHaveLength(1)
    const sub = readFileSync(join(tempDir, 'finance-x.md'), 'utf-8')
    expect(sub).toContain('fresh')
    expect(sub).not.toContain('old content')
  })

  it('re-running with same plan (force:true) is idempotent on the hub index', () => {
    writeFileSync(topicPath, makeTopic('finance', 'pre', [
      { h: 'NVDA', body: 'nvda' },
      { h: 'kept', body: 'kept' },
    ]), 'utf-8')
    const plan: SplitPlan = {
      subTopics: [{ name: 'investment', title: '投资', headings: ['## NVDA'] }],
    }
    const r1 = splitTopic(topicPath, plan)
    const hub1 = readFileSync(topicPath, 'utf-8')

    const r2 = splitTopic(topicPath, plan, { force: true })
    const hub2 = readFileSync(topicPath, 'utf-8')

    expect(hub2).toBe(hub1)
    expect(r2.unmovedHeadings).toEqual(['## kept'])
    // sub_topic_index marker exists exactly once
    expect(hub2.match(/sub-topic-index: managed/g) ?? []).toHaveLength(1)
  })

  it('rejects empty plan', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [{ h: 'A', body: 'a' }]), 'utf-8')
    expect(() => splitTopic(topicPath, { subTopics: [] })).toThrow(/empty/)
  })

  it('rejects sub-topic with zero headings', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [{ h: 'A', body: 'a' }]), 'utf-8')
    expect(() => splitTopic(topicPath, { subTopics: [{ name: 'x', title: 'X', headings: [] }] })).toThrow(/no headings/)
  })

  it('rejects invalid sub-topic name (must be [a-z0-9-]+)', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [{ h: 'A', body: 'a' }]), 'utf-8')
    expect(() =>
      splitTopic(topicPath, { subTopics: [{ name: 'BadName', title: 'X', headings: ['## A'] }] }),
    ).toThrow(/\[a-z0-9-\]/)
  })

  it('preserves section body verbatim (multi-line content + ### sub-headings)', () => {
    const bodyText = 'first paragraph\n\n### nested heading\n\nmore content\n\n- bullet 1\n- bullet 2'
    writeFileSync(topicPath, makeTopic('finance', '', [
      { h: 'NVDA', body: bodyText },
      { h: 'kept', body: 'kept body' },
    ]), 'utf-8')
    const plan: SplitPlan = {
      subTopics: [{ name: 'investment', title: '投资', headings: ['## NVDA'] }],
    }
    splitTopic(topicPath, plan)
    const sub = readFileSync(join(tempDir, 'finance-investment.md'), 'utf-8')
    expect(sub).toContain('first paragraph')
    expect(sub).toContain('### nested heading')
    expect(sub).toContain('- bullet 1')
    expect(sub).toContain('- bullet 2')
  })

  it('belowThreshold flag reflects hub line count vs threshold', () => {
    const bigBody = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    writeFileSync(topicPath, makeTopic('finance', '', [
      { h: 'move-me', body: bigBody },
      { h: 'tiny', body: 'small' },
    ]), 'utf-8')
    const plan: SplitPlan = {
      subTopics: [{ name: 'large', title: '大', headings: ['## move-me'] }],
    }
    const r = splitTopic(topicPath, plan, { threshold: 50 })
    expect(r.belowThreshold).toBe(true)  // hub now has just the tiny section + frontmatter + index
    expect(r.subTopicsWritten[0].lines).toBeGreaterThan(50)
  })

  it('reports unmovedHeadings (the hub-kept set)', () => {
    writeFileSync(topicPath, makeTopic('finance', '', [
      { h: 'A', body: 'a' },
      { h: 'B', body: 'b' },
      { h: 'C', body: 'c' },
      { h: 'D', body: 'd' },
    ]), 'utf-8')
    const r = splitTopic(topicPath, {
      subTopics: [{ name: 'one', title: '1', headings: ['## A', '## C'] }],
    })
    expect(r.unmovedHeadings.sort()).toEqual(['## B', '## D'])
  })

  it('throws when topic file does not exist', () => {
    expect(() => splitTopic(join(tempDir, 'nope.md'), { subTopics: [{ name: 'x', title: 'X', headings: ['## A'] }] })).toThrow(/not found/)
  })
})
