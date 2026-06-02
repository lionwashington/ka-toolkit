import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { splitDailyLog } from '../src/daily-log/splitter.js'
import { parseFrontmatter } from '../src/knowledge-store/markdown.js'

function makeBody(thread: number, lines: number): string {
  const out: string[] = [`## 主线 ${thread}: 标题 ${thread}`, '']
  for (let i = 1; i <= lines; i++) out.push(`第 ${thread}-${i} 行的内容文字。`)
  return out.join('\n')
}

function makeDailyLog(date: string, threads: Array<{ num: number; lines: number }>): string {
  const head = `---
title: ${date} daily
date: ${date}
tags:
  - daily
---

## TL;DR

- **核心事件**: 测试用 stub
- **anchor 校正**: 无
- **教训**: 无
- **数字 anchor**: 无
- **Carry-over**: 无

---

# ${date} — test daily

`
  return head + threads.map(t => makeBody(t.num, t.lines)).join('\n\n')
}

describe('splitDailyLog', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-daily-log-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('under threshold: no-op, no part file written', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    writeFileSync(filePath, makeDailyLog('2026-05-25', [{ num: 1, lines: 100 }]), 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000 })

    expect(r.split).toBe(false)
    expect(r.reason).toBe('under-threshold')
    expect(readdirSync(tempDir)).toEqual(['2026-05-25.md'])
  })

  it('over threshold: splits at the last `## 主线 N:` heading ≤ threshold', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 600 },
      { num: 2, lines: 600 },
    ]), 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000 })

    expect(r.split).toBe(true)
    expect(r.reason).toBe('split')
    expect(r.partNumber).toBe(2)
    expect(r.partFilePath).toContain('2026-05-25-part2.md')

    const main = readFileSync(filePath, 'utf-8')
    expect(main).toContain('## 主线 1:')
    expect(main).not.toContain('## 主线 2:')
    expect(main).toContain('→ continued [[2026-05-25-part2]]')
    expect(main).toContain('## TL;DR')

    const part = readFileSync(r.partFilePath!, 'utf-8')
    const { data, content } = parseFrontmatter(part)
    expect(data.part).toBe(2)
    expect(data.parent).toBe('2026-05-25.md')
    expect(data.date).toBe('2026-05-25')
    expect(content).toContain('← [[2026-05-25]] (main file has TL;DR)')
    expect(content).toContain('## 主线 2:')
    expect(content).not.toContain('## TL;DR')
  })

  it('bilingual: also splits at the English `## Thread N:` heading (legacy 主线 stays supported)', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    const body = (n: number, lines: number) =>
      [`## Thread ${n}: title ${n}`, '', ...Array.from({ length: lines }, (_, i) => `line ${n}-${i + 1} content.`)].join('\n')
    writeFileSync(
      filePath,
      `---\ntitle: 2026-05-25 daily\ndate: 2026-05-25\ntags:\n  - daily\n---\n\n## TL;DR\n\n- stub\n\n---\n\n${body(1, 600)}\n\n${body(2, 600)}`,
      'utf-8',
    )

    const r = splitDailyLog(filePath, { threshold: 1000 })

    expect(r.split).toBe(true)
    expect(r.reason).toBe('split')
    const main = readFileSync(filePath, 'utf-8')
    expect(main).toContain('## Thread 1:')
    expect(main).not.toContain('## Thread 2:')
    const part = readFileSync(r.partFilePath!, 'utf-8')
    expect(part).toContain('## Thread 2:')
  })

  it('cut boundary is the LAST 主线 heading ≤ threshold (not the first)', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 200 },
      { num: 2, lines: 200 },
      { num: 3, lines: 200 },
      { num: 4, lines: 200 },
      { num: 5, lines: 600 },
    ]), 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000 })

    expect(r.split).toBe(true)
    const main = readFileSync(filePath, 'utf-8')
    const part = readFileSync(r.partFilePath!, 'utf-8')

    // 主线 5 starts after line ~1000 → so the LAST heading ≤ 1000 should be 主线 5 if it falls within, else 主线 4.
    // Either way, 主线 5 must end up in the part file.
    expect(part).toContain('## 主线 5:')
    expect(main).toContain('## 主线 1:')
    expect(main).toContain('## 主线 4:')
  })

  it('no boundary found in first <threshold> lines: hard fallback', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    // Single huge thread of 2000 lines; the only 主线 heading is at top.
    // Wait — the heading IS at top (within first 30 lines), so we WILL find it.
    // To trigger fallback, we need NO heading in first 1000 lines at all.
    const body = `---
title: 2026-05-25 daily
date: 2026-05-25
tags:
  - daily
---

`
    const padding = Array.from({ length: 1500 }, (_, i) => `padding line ${i}`).join('\n')
    const tail = '\n\n## 主线 1: only-heading-at-the-bottom\n\nshort content\n'
    writeFileSync(filePath, body + padding + tail, 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000 })

    expect(r.split).toBe(true)
    expect(r.reason).toBe('no-boundary-found')
    expect(r.cutLineIndex).toBe(1000)
  })

  it('chained split: part2 still > threshold → part3', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    // 3 主线 each 800 lines → total ~2400 lines.
    // First split: cut at end of 主线 1 (~800) → part2 holds 主线 2 + 主线 3 = ~1600 lines.
    // Second split (chained on part2): cut at 主线 3 → part3 holds 主线 3.
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 800 },
      { num: 2, lines: 800 },
      { num: 3, lines: 800 },
    ]), 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000, maxChainDepth: 5 })

    expect(r.split).toBe(true)
    expect(r.partNumber).toBe(2)
    expect(r.chained).toBeDefined()
    expect(r.chained!.split).toBe(true)
    expect(r.chained!.partNumber).toBe(3)
    expect(r.chained!.partFilePath).toContain('2026-05-25-part3.md')

    const main = readFileSync(filePath, 'utf-8')
    const part2 = readFileSync(r.partFilePath!, 'utf-8')
    const part3 = readFileSync(r.chained!.partFilePath!, 'utf-8')

    expect(main).toContain('→ continued [[2026-05-25-part2]]')
    expect(part2).toContain('← [[2026-05-25]] (main file has TL;DR)')
    expect(part2).toContain('→ continued [[2026-05-25-part3]]')
    expect(part3).toContain('← [[2026-05-25-part2]] (previous part)')
    expect(part3).toContain('[[2026-05-25]] (main file has TL;DR)')

    // Each main / part should now be under threshold individually.
    const wc = (s: string) => s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
    expect(wc(main)).toBeLessThanOrEqual(1000)
    expect(wc(part2)).toBeLessThanOrEqual(1000)
  })

  it('TL;DR appears ONLY in the main file, never in any part', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 800 },
      { num: 2, lines: 800 },
      { num: 3, lines: 800 },
    ]), 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000, maxChainDepth: 5 })

    const main = readFileSync(filePath, 'utf-8')
    expect(main).toMatch(/^---\n[\s\S]*?\n## TL;DR/m)

    const part2 = readFileSync(r.partFilePath!, 'utf-8')
    expect(part2).not.toContain('## TL;DR')
    if (r.chained?.partFilePath) {
      const part3 = readFileSync(r.chained.partFilePath, 'utf-8')
      expect(part3).not.toContain('## TL;DR')
    }
  })

  it('throws when filename does not start with YYYY-MM-DD', () => {
    const filePath = join(tempDir, 'not-a-date.md')
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 600 },
      { num: 2, lines: 600 },
    ]), 'utf-8')

    expect(() => splitDailyLog(filePath, { threshold: 1000 })).toThrow(/YYYY-MM-DD/)
  })

  it('chained depth cap: stops after maxChainDepth even if still over threshold', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    // 5 huge threads — should chain ≥ 3 times normally; we'll cap at 2.
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 700 },
      { num: 2, lines: 700 },
      { num: 3, lines: 700 },
      { num: 4, lines: 700 },
      { num: 5, lines: 700 },
    ]), 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000, maxChainDepth: 2 })

    expect(r.split).toBe(true)
    // depth cap: result.chained may exist (depth 2 hit) but no chained.chained.
    const tail = r.chained ?? r
    expect(tail.chained?.split).not.toBe(true)
  })

  it('idempotent re-run: a file already under threshold returns no-op even if part files exist', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 600 },
      { num: 2, lines: 600 },
    ]), 'utf-8')
    splitDailyLog(filePath, { threshold: 1000 })

    // Re-run; main should now be under threshold.
    const r2 = splitDailyLog(filePath, { threshold: 1000 })
    expect(r2.split).toBe(false)
    expect(existsSync(join(tempDir, '2026-05-25-part2.md'))).toBe(true)
    expect(existsSync(join(tempDir, '2026-05-25-part3.md'))).toBe(false)
  })

  it('next part number increments past existing part files', () => {
    const filePath = join(tempDir, '2026-05-25.md')
    writeFileSync(join(tempDir, '2026-05-25-part2.md'), 'placeholder', 'utf-8')
    writeFileSync(join(tempDir, '2026-05-25-part5.md'), 'placeholder', 'utf-8')
    writeFileSync(filePath, makeDailyLog('2026-05-25', [
      { num: 1, lines: 600 },
      { num: 2, lines: 600 },
    ]), 'utf-8')

    const r = splitDailyLog(filePath, { threshold: 1000 })
    expect(r.partNumber).toBe(6)
    expect(r.partFilePath).toContain('2026-05-25-part6.md')
  })
})
