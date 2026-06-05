import { describe, it, expect } from 'vitest'
import { evaluate, formatReport, type SearchFn, type EvalCase } from './eval.js'

const cases: EvalCase[] = [
  { query: 'clash nat', expect: ['tech-network'] },     // will be top-1
  { query: 'dns 分流', expect: ['tech-dns'] },          // will be top-3 (rank 2)
  { query: '不存在的', expect: ['nope'] },               // miss
]

// Deterministic fake search keyed by query.
const fakeSearch: SearchFn = async (q) => {
  if (q === 'clash nat') return [{ topic: 'tech-network' }, { topic: 'tech-dns' }]
  if (q === 'dns 分流') return [{ topic: 'a' }, { topic: 'b' }, { topic: 'tech-dns' }]
  return [{ topic: 'x' }, { topic: 'y' }]
}

describe('evaluate', () => {
  it('computes top1 / top3 / MRR and lists misses', async () => {
    const r = await evaluate(fakeSearch, cases, 5)
    expect(r.n).toBe(3)
    expect(r.top1).toBeCloseTo(1 / 3) // only 'clash nat' is rank 0
    expect(r.top3).toBeCloseTo(2 / 3) // 'clash nat'(0) + 'dns 分流'(2)
    // MRR = (1/1 + 1/3 + 0) / 3
    expect(r.mrr).toBeCloseTo((1 + 1 / 3) / 3)
    expect(r.misses.map((m) => m.query)).toEqual(['不存在的'])
  })

  it('formatReport produces a one-liner', async () => {
    const r = await evaluate(fakeSearch, cases, 5)
    expect(formatReport(r)).toMatch(/top1=.*top3=.*MRR=.*misses=1/)
  })
})
