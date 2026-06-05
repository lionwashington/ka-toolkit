// End-to-end validation with the REAL multilingual-e5-large model on the self-made
// sanitized corpus (tests/kb-eval). Slow (model load ~50s) → guarded behind RUN_E5=1
// so the default suite stays fast. Run explicitly:  RUN_E5=1 npx vitest run e5-e2e
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmbedder } from './embedder.js'
import { LanceEngine } from './lance-engine.js'
import { reindex } from './indexer.js'
import { evaluate, formatReport, type EvalCase } from './eval.js'

const RUN = process.env.RUN_E5 === '1'
const REPO = join(import.meta.dirname, '..', '..', '..', '..') // kb/core/src/retrieval → repo root

describe.runIf(RUN)('e5 e2e (real model, slow — RUN_E5=1)', () => {
  it('reindex self-made corpus + eval fixture: top-3 high, network/colloquial hit, log not winning', async () => {
    const corpus = join(REPO, 'tests/kb-eval/corpus')
    const fixture = JSON.parse(readFileSync(join(REPO, 'tests/kb-eval/queries.example.json'), 'utf-8')) as EvalCase[]
    const dir = mkdtempSync(join(tmpdir(), 'kb-e5-e2e-'))
    try {
      const emb = createEmbedder() // real multilingual-e5-large
      const engine = new LanceEngine(join(dir, 'db'), emb)
      const built = await reindex(engine, corpus, emb)
      const report = await evaluate(
        (q, k) => engine.search(q, k).then((h) => h.map((x) => ({ topic: x.topic }))),
        fixture,
        5,
      )
      // eslint-disable-next-line no-console
      console.log(`\n  indexed ${built.docCount} docs / ${built.rows.length} chunks, dim=${emb.dim()}`)
      // eslint-disable-next-line no-console
      console.log('  ' + formatReport(report))
      for (const r of report.results) {
        // eslint-disable-next-line no-console
        console.log(`    ${r.hitRank === 0 ? '✓1' : r.hitRank >= 0 && r.hitRank < 3 ? '~3' : '✗ '} [${r.top.slice(0, 3).join(', ')}]  <= ${r.query}`)
      }
      // Gates: most queries hit top-3; the two network cases (regression + colloquial) hit sample-network.
      expect(report.top3).toBeGreaterThanOrEqual(0.8)
      const net = report.results.filter((r) => r.expect.includes('sample-network'))
      expect(net.every((r) => r.hitRank >= 0 && r.hitRank < 3)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
