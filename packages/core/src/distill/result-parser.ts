import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { parseFrontmatter } from '../knowledge-store/markdown.js'

export type ParseTier = 'stats-file' | 'result-json' | 'log-grep' | 'mtime-scan' | 'unknown'

export interface ParsedDistillResult {
  tier: ParseTier
  rawAdded: number | null
  conversationsUpdated: number | null
  topicsUpdated: number | null
  rawFiles: string[]
  conversationsFiles: string[]
  topicsFiles: string[]
  phase1Completed: boolean
  notes: string
}

export interface ParseOptions {
  logPath: string
  memoryDir: string
  startTimeIso: string
  /**
   * Path the distill agent was told to Write its stats JSON to. Checked FIRST
   * (tier 0) — a file the agent wrote with the Write tool is far more reliable
   * than hoping its final assistant message happens to be the stats JSON.
   */
  statsFilePath?: string
}

export function parseDistillResult(opts: ParseOptions): ParsedDistillResult {
  const startMs = Date.parse(opts.startTimeIso)
  if (Number.isNaN(startMs)) {
    throw new Error(`parseDistillResult: invalid startTimeIso "${opts.startTimeIso}"`)
  }

  let logText = ''
  try {
    logText = readFileSync(opts.logPath, 'utf-8')
  } catch {
    // No log → caller-supplied path was wrong. Treat as unknown.
    logText = ''
  }

  // --- Tier 0: the stats file the agent was told to Write -----------------
  // Most reliable: a file written via the Write tool, unaffected by whether the
  // agent's final message happened to be the stats JSON (it often ends on a
  // tool call instead, leaving claude's .result empty).
  if (opts.statsFilePath) {
    const tier0 = extractFromStatsFile(opts.statsFilePath)
    if (tier0) {
      return finalize('stats-file', tier0, opts, 'parsed from the stats file the distill agent wrote')
    }
  }

  // --- Tier 1: try the claude wrapper's `result` field --------------------
  const tier1 = extractFromClaudeResult(logText)
  if (tier1) {
    return finalize('result-json', tier1, opts, 'parsed from claude .result final JSON line')
  }

  // --- Tier 2: grep the raw log for any `{"raw_added":...}` line ----------
  const tier2 = extractFromLogGrep(logText)
  if (tier2) {
    return finalize('log-grep', tier2, opts,
      'fell back to grep — claude .result was empty or mis-formatted, but a stats JSON line was present in the log')
  }

  // --- Tier 3: mtime-scan memory/* for files touched after start_time -----
  const tier3 = mtimeScan(opts.memoryDir, startMs)
  if (tier3.rawFiles.length > 0 || tier3.conversationsFiles.length > 0 || tier3.topicsFiles.length > 0) {
    return finalize('mtime-scan', tier3, opts,
      'fell back to mtime scan — no JSON stats found; counts derived from files touched after worker start_time')
  }

  // --- Tier 4: nothing landed --------------------------------------------
  return finalize('unknown', {
    rawAdded: null,
    conversationsUpdated: null,
    topicsUpdated: null,
    rawFiles: [],
    conversationsFiles: [],
    topicsFiles: [],
  }, opts, 'no JSON stats and no files were touched after start_time')
}

interface RawStats {
  rawAdded: number | null
  conversationsUpdated: number | null
  topicsUpdated: number | null
  rawFiles: string[]
  conversationsFiles: string[]
  topicsFiles: string[]
}

function finalize(tier: ParseTier, partial: RawStats, opts: ParseOptions, notes: string): ParsedDistillResult {
  const phase1Completed = anyRawNewlyDistilled(opts.memoryDir, Date.parse(opts.startTimeIso))
  return {
    tier,
    rawAdded: partial.rawAdded,
    conversationsUpdated: partial.conversationsUpdated,
    topicsUpdated: partial.topicsUpdated,
    rawFiles: partial.rawFiles,
    conversationsFiles: partial.conversationsFiles,
    topicsFiles: partial.topicsFiles,
    phase1Completed,
    notes,
  }
}

function extractFromStatsFile(path: string): RawStats | null {
  let text = ''
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return null // file absent (agent didn't write it) → let later tiers handle
  }
  const trimmed = text.trim()
  if (!trimmed) return null
  // The file should be exactly the stats JSON; be defensive about a trailing
  // newline, a code fence, or prose the agent might have wrapped around it.
  const direct = tryParseStats(trimmed)
  if (direct) return direct
  const embedded = extractFirstJsonObject(text)
  if (embedded) return statsFromObject(embedded)
  return null
}

function extractFromClaudeResult(logText: string): RawStats | null {
  if (!logText) return null
  // The claude `-p --output-format json` wrapper produces one JSON line with a
  // `.result` text field. Scan every line for the LAST one that parses
  // (defensively: real CC may or may not emit a trailing newline, so a line
  // may have trailing prose appended by subsequent log writes).
  const lines = logText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const obj = extractFirstJsonObject(line)
    if (!obj) continue
    const outer = obj as { type?: unknown; result?: unknown }
    if (outer.type !== 'result' && !('result' in outer)) continue
    if (typeof outer.result !== 'string' || outer.result.length === 0) {
      return null  // result missing or empty — let the next tier handle it
    }
    const resultText = outer.result
    const innerLines = resultText.split('\n').map(s => s.trim()).filter(Boolean)
    for (let j = innerLines.length - 1; j >= 0; j--) {
      const stats = tryParseStats(innerLines[j])
      if (stats) return stats
      // Defensive: try extracting an embedded JSON object too (in case the LLM
      // wrote the stats inline with surrounding prose on the same line).
      const embedded = extractFirstJsonObject(innerLines[j])
      if (embedded) {
        const stats2 = statsFromObject(embedded)
        if (stats2) return stats2
      }
    }
    return null  // had result text but no parseable stats
  }
  return null
}

function extractFromLogGrep(logText: string): RawStats | null {
  if (!logText) return null
  // Scan every line of the log for a stats JSON object. Take the LAST match
  // (most-recent attempt by the worker LLM, if it tried several times).
  const lines = logText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"raw_added"')) continue
    // First try the pristine path: the line is exactly the JSON.
    const trimmed = line.trim()
    const stats = tryParseStats(trimmed)
    if (stats) return stats
    // Strip markdown code fence if present.
    const dewrapped = trimmed.replace(/^`+|`+$/g, '').trim()
    const stats2 = tryParseStats(dewrapped)
    if (stats2) return stats2
    // Defensive: pull the first balanced JSON object out of the line (handles
    // prose mixed with JSON, claude wrapper line without a trailing newline,
    // etc.).
    const embedded = extractFirstJsonObject(line)
    if (embedded) {
      const stats3 = statsFromObject(embedded)
      if (stats3) return stats3
    }
  }
  return null
}

function tryParseStats(line: string): RawStats | null {
  let j: unknown
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  return statsFromObject(j as Record<string, unknown>)
}

function statsFromObject(j: unknown): RawStats | null {
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (
    typeof o.raw_added !== 'number' ||
    typeof o.conversations_updated !== 'number' ||
    typeof o.topics_updated !== 'number'
  ) return null
  return {
    rawAdded: o.raw_added,
    conversationsUpdated: o.conversations_updated,
    topicsUpdated: o.topics_updated,
    rawFiles: stringArray(o.raw_files),
    conversationsFiles: stringArray(o.conversations_files),
    topicsFiles: stringArray(o.topics_files),
  }
}

/**
 * Walk forward through `line`, find the first balanced JSON object literal,
 * and return its parsed form. Returns null if no balanced object exists.
 * Honours JS string escape rules (handles braces inside strings correctly).
 */
function extractFirstJsonObject(line: string): unknown | null {
  const start = line.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === '"') { inStr = false; continue }
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        const candidate = line.slice(start, i + 1)
        try { return JSON.parse(candidate) } catch { return null }
      }
    }
  }
  return null
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter(x => typeof x === 'string') as string[]
}

function mtimeScan(memoryDir: string, startMs: number): RawStats {
  const result: RawStats = {
    rawAdded: 0,
    conversationsUpdated: 0,
    topicsUpdated: 0,
    rawFiles: [],
    conversationsFiles: [],
    topicsFiles: [],
  }
  for (const sub of ['raw', 'conversations', 'topics'] as const) {
    const dir = join(memoryDir, sub)
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const touched: string[] = []
    for (const f of entries) {
      if (!f.endsWith('.md')) continue
      const fp = join(dir, f)
      try {
        const st = statSync(fp)
        if (st.mtimeMs > startMs) touched.push(f)
      } catch { /* skip */ }
    }
    touched.sort()
    if (sub === 'raw') {
      result.rawFiles = touched
      result.rawAdded = touched.length
    } else if (sub === 'conversations') {
      result.conversationsFiles = touched
      result.conversationsUpdated = touched.length
    } else {
      result.topicsFiles = touched
      result.topicsUpdated = touched.length
    }
  }
  return result
}

function anyRawNewlyDistilled(memoryDir: string, startMs: number): boolean {
  const dir = join(memoryDir, 'raw')
  if (!existsSync(dir)) return false
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue
    const fp = join(dir, f)
    try {
      const st = statSync(fp)
      if (st.mtimeMs <= startMs) continue
      const { data } = parseFrontmatter(readFileSync(fp, 'utf-8'))
      if (data.distilled === true) return true
    } catch { /* skip */ }
  }
  return false
}
