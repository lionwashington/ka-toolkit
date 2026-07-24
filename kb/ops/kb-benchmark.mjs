#!/usr/bin/env node
// Compare embedding vs FTS5 through the running daemon's loopback diagnostic API.
// The private fixture stays outside the public repo; only aggregate metrics print.
import { readFileSync } from 'node:fs'

const fixturePath = process.argv[2] || process.env.KA_KB_EVAL_FIXTURE
const base = process.env.KA_KB_URL || 'http://127.0.0.1:7705'
const requested = process.argv[3] || 'both'
if (!fixturePath || !['embedding', 'fts5', 'both'].includes(requested)) {
  console.error('usage: ka kb benchmark <fixture.json|fixture.md> [embedding|fts5|both]')
  process.exit(2)
}

function loadCases(path) {
  const raw = readFileSync(path, 'utf8')
  const json = path.endsWith('.json')
    ? raw
    : raw.match(/```json\s*([\s\S]*?)```/i)?.[1]
  if (!json) throw new Error('fixture has no JSON array/code block')
  const cases = JSON.parse(json)
  if (!Array.isArray(cases)) throw new Error('fixture must be a JSON array')
  return cases
}

async function status() {
  const response = await fetch(`${base}/api/status`)
  if (!response.ok) throw new Error(`status HTTP ${response.status}`)
  return response.json()
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

async function runMode(mode, cases) {
  const before = await status()
  const results = []
  for (let index = 0; index < cases.length; index++) {
    const c = cases[index]
    try {
      const response = await fetch(`${base}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: c.query, mode, max_results: 5 }),
        signal: AbortSignal.timeout(Number(process.env.KA_KB_BENCH_QUERY_TIMEOUT_MS) || 120_000),
      })
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || `search HTTP ${response.status}`)
      const topics = payload.results.map((r) => r.path.replace(/^.*\//, '').replace(/\.md$/, ''))
      const expected = new Set(c.expect)
      results.push({
        ms: payload.elapsed_ms,
        rank: topics.findIndex((topic) => expected.has(topic)),
        error: null,
      })
    } catch (error) {
      results.push({ ms: 120_000, rank: -1, error: error instanceof Error ? error.message : String(error) })
    }
    if ((index + 1) % 5 === 0 || index + 1 === cases.length) {
      process.stderr.write(`[benchmark] ${mode}: ${index + 1}/${cases.length}\n`)
    }
  }
  const after = await status()
  const latencies = results.map((r) => r.ms)
  const n = results.length || 1
  return {
    mode,
    queries: results.length,
    quality: {
      top1: results.filter((r) => r.rank === 0).length / n,
      top3: results.filter((r) => r.rank >= 0 && r.rank < 3).length / n,
      mrr: results.reduce((sum, r) => sum + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0) / n,
      misses: results.filter((r) => r.rank < 0).length,
      errors: results.filter((r) => r.error).length,
    },
    latency_ms: {
      first: latencies[0] ?? 0,
      mean: latencies.reduce((sum, value) => sum + value, 0) / n,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(0, ...latencies),
    },
    daemon: {
      rss_before_mb: before.memory.rss_bytes / 1024 / 1024,
      rss_after_mb: after.memory.rss_bytes / 1024 / 1024,
      cpu_user_ms: (after.cpu.user_us - before.cpu.user_us) / 1000,
      cpu_system_ms: (after.cpu.system_us - before.cpu.system_us) / 1000,
    },
  }
}

const cases = loadCases(fixturePath)
const modes = requested === 'both' ? ['fts5', 'embedding'] : [requested]
const reports = []
for (const mode of modes) reports.push(await runMode(mode, cases))
console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  cases: cases.length,
  reports,
}, null, 2))
