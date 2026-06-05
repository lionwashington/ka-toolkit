// Retrieval eval harness: run a (query → expected topics) fixture against the
// engine and score top-1 / top-3 hit-rate + MRR. Used to (a) baseline the current
// Orama before migration and (b) gate the LanceDB engine (the known Clash-NAT miss
// must move to top-1..3, and the set must beat baseline). The REAL fixture (private
// KB queries) lives outside this repo (env KA_KB_EVAL_FIXTURE); the repo ships only
// a sanitized example. This module is content-agnostic.
export interface EvalCase {
  query: string
  /** Topic name(s) (filename stem) any of which counts as a hit. */
  expect: string[]
  note?: string
}

export interface EvalCaseResult {
  query: string
  expect: string[]
  /** 0-based rank of the first expected topic in the results, or -1 if missed. */
  hitRank: number
  top: string[]
  note?: string
}

export interface EvalReport {
  n: number
  top1: number // fraction with hitRank === 0
  top3: number // fraction with 0 <= hitRank < 3
  mrr: number // mean reciprocal rank
  misses: EvalCaseResult[]
  results: EvalCaseResult[]
}

export type SearchFn = (query: string, topK: number) => Promise<{ topic: string }[]>

export async function evaluate(search: SearchFn, cases: EvalCase[], topK = 5): Promise<EvalReport> {
  const results: EvalCaseResult[] = []
  for (const c of cases) {
    const hits = await search(c.query, topK)
    const top = hits.map((h) => h.topic)
    const expectSet = new Set(c.expect)
    const hitRank = top.findIndex((t) => expectSet.has(t))
    results.push({ query: c.query, expect: c.expect, hitRank, top, note: c.note })
  }
  const n = results.length || 1
  const top1 = results.filter((r) => r.hitRank === 0).length / n
  const top3 = results.filter((r) => r.hitRank >= 0 && r.hitRank < 3).length / n
  const mrr = results.reduce((s, r) => s + (r.hitRank >= 0 ? 1 / (r.hitRank + 1) : 0), 0) / n
  return { n: results.length, top1, top3, mrr, misses: results.filter((r) => r.hitRank < 0), results }
}

/** One-line summary for logs / kb_status. */
export function formatReport(r: EvalReport): string {
  const pct = (x: number) => (x * 100).toFixed(1) + '%'
  return `eval: n=${r.n}  top1=${pct(r.top1)}  top3=${pct(r.top3)}  MRR=${r.mrr.toFixed(3)}  misses=${r.misses.length}`
}
