// ka kb lint — deterministic, read-only structural self-check of the knowledge base.
// No native deps, no model load (same tier as the daily-log / topics splitters): it
// parses topics/ + conversations/ + raw/ + INDEX.md once into an in-memory model and
// runs five checks against it. The semantic check 6 (contradictions) is NOT here — it
// is a separate LLM `--deep` pass (see docs/components/kb-lint.md, Step 3).
//
// Inspired by Karpathy's "LLM Wiki" lint pillar. Design notes that shaped this file:
//  - the wikilink resolver must span topics ∪ conversations ∪ raw (the KB cross-links to
//    all three; a topics-only resolver false-positives the conversation/raw links);
//  - INDEX may be intentionally minimal (kb_search-routed, lists no topics), so the
//    "missing from INDEX" drift direction is only meaningful for a catalog-style INDEX.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { parseFrontmatter } from '../knowledge-store/markdown.js'
import { KnowledgeStore } from '../knowledge-store/store.js'

export type Severity = 'error' | 'warning' | 'info'

export interface LintFinding {
  check: string
  severity: Severity
  file: string // KB-relative, e.g. "topics/foo.md"
  message: string
  detail?: string // the offending link text, missing field, etc.
  suggestion?: string // nearest-match hint for a dead link
}

/**
 * Whole-KB statistics (the full picture, not just what's wrong) — emitted alongside
 * findings so the health of the KB can be cross-checked against an independent count.
 * Definitions are fixed so two counters (e.g. lint vs a manual scan) measure the same thing.
 */
export interface LintStats {
  topics: number // count of topics/*.md
  conversations: number // count of conversations/*.md
  raw: number // count of raw/*.md
  wikilinks: { total: number; resolved: number; broken: number } // [[..]] in topics+conversations+INDEX (code spans excluded)
  orphanTopics: number // non-meta/noise topics with no inbound topic edge
  rawDistilled: number // raw with distilled: true
  rawUndistilled: number // raw NOT distilled: true (backlog)
  rawWithValidBackref: number // raw whose topics: names ≥1 existing topic
  rawNoise: number // raw whose topics: includes noise-spawn-handshake
  rawEmptyBackref: number // distilled raw with empty/absent topics:
  rawDanglingBackref: number // raw whose topics: names a non-existent topic (incl. conversation refs)
}

export interface LintReport {
  kbPath: string
  scale: { topics: number; conversations: number; raw: number }
  indexStyle: 'catalog' | 'minimal' | 'absent'
  stats: LintStats
  findings: LintFinding[]
  counts: { error: number; warning: number; info: number }
  byCheck: Record<string, number>
  exitCode: 0 | 1 | 2
}

interface MdFile {
  stem: string // filename without .md
  rel: string // KB-relative path
  abs: string
  data: Record<string, unknown>
  body: string
  parseError?: string // set when frontmatter failed to parse
}

interface KbModel {
  topics: MdFile[]
  conversations: MdFile[]
  raw: MdFile[]
  indexLinks: LinkRef[] // wikilinks found in INDEX.md
  indexExists: boolean
  /** Every resolvable target name: stems of all three dirs + titles of topics. */
  resolvable: Set<string>
  topicStems: Set<string>
  topicTitles: Set<string>
}

interface LinkRef {
  target: string // normalized (no dir prefix / #anchor / .md / |label)
  rawText: string // the original [[...]] inner text
}

// ── parsing helpers ──────────────────────────────────────────────────────────

function listMd(dir: string): MdFile[] {
  if (!existsSync(dir)) return []
  const out: MdFile[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const abs = join(dir, f)
    const stem = f.replace(/\.md$/, '')
    const rel = `${basename(dir)}/${f}`
    let raw: string
    try {
      raw = readFileSync(abs, 'utf-8')
    } catch (e) {
      out.push({ stem, rel, abs, data: {}, body: '', parseError: `read failed: ${(e as Error).message}` })
      continue
    }
    try {
      const { data, content } = parseFrontmatter(raw)
      out.push({ stem, rel, abs, data: data as Record<string, unknown>, body: content })
    } catch (e) {
      // Malformed YAML frontmatter — gray-matter throws. This is the case the store's
      // listTopics() silently swallows (catch → null), so the topic vanishes from
      // kb_list_topics with no signal. Record it so check 4 can surface it.
      out.push({ stem, rel, abs, data: {}, body: '', parseError: `frontmatter parse failed: ${(e as Error).message}` })
    }
  }
  return out
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

// Blank out code so a `[[wikilink]]` shown as a CODE EXAMPLE (documenting the link format,
// e.g. "use `[[wikilink]]` format" or a fenced template `→ 续 [[<date>-part<N>]]`) is NOT
// mistaken for a real, broken link. Order matters: fences before inline; double before
// single backticks. Replace with spaces to keep offsets/line structure intact.
function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, m => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, m => ' '.repeat(m.length))
    .replace(/``[\s\S]*?``/g, m => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
}

/** Strip the |label, #anchor, dir prefix and .md suffix → the bare target name. */
function normalizeTarget(inner: string): string {
  let t = inner.split('|')[0] // drop display label
  t = t.split('#')[0] // drop heading anchor
  t = t.trim()
  t = t.replace(/^(?:topics|conversations|raw)\//, '') // drop dir prefix
  t = t.replace(/^\.\//, '')
  t = t.replace(/\.md$/, '') // drop a stray .md suffix (a real bug class)
  return t.trim()
}

function extractLinks(body: string): LinkRef[] {
  const out: LinkRef[] = []
  for (const m of stripCode(body).matchAll(WIKILINK_RE)) {
    const inner = m[1]
    out.push({ target: normalizeTarget(inner), rawText: inner.trim() })
  }
  return out
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

// ── model build ──────────────────────────────────────────────────────────────

function buildModel(kbPath: string): KbModel {
  const topics = listMd(join(kbPath, 'topics'))
  const conversations = listMd(join(kbPath, 'conversations'))
  const raw = listMd(join(kbPath, 'raw'))

  const topicStems = new Set(topics.map(t => t.stem))
  const topicTitles = new Set(
    topics.map(t => (typeof t.data.title === 'string' ? (t.data.title as string) : '')).filter(Boolean),
  )

  // A wikilink resolves if its target matches a stem of ANY of the three dirs, or a
  // topic title. (store.ts accepts both stem and title; the KB cross-links to
  // conversations/raw too, so those stems must be resolvable.)
  const resolvable = new Set<string>()
  for (const f of [...topics, ...conversations, ...raw]) resolvable.add(f.stem)
  for (const t of topicTitles) resolvable.add(t)

  const indexAbs = join(kbPath, 'INDEX.md')
  let indexLinks: LinkRef[] = []
  let indexExists = false
  if (existsSync(indexAbs)) {
    indexExists = true
    try {
      const { content } = parseFrontmatter(readFileSync(indexAbs, 'utf-8'))
      indexLinks = extractLinks(content)
    } catch {
      indexLinks = extractLinks(readFileSync(indexAbs, 'utf-8'))
    }
  }

  return { topics, conversations, raw, indexLinks, indexExists, resolvable, topicStems, topicTitles }
}

function indexStyleOf(m: KbModel): 'catalog' | 'minimal' | 'absent' {
  if (!m.indexExists) return 'absent'
  // Catalog = INDEX links out to topics. Minimal = an architecture note with no topic
  // links (this KB declares routing is kb_search-only).
  const topicLinkCount = m.indexLinks.filter(l => m.topicStems.has(l.target) || m.topicTitles.has(l.target)).length
  return topicLinkCount > 0 ? 'catalog' : 'minimal'
}

// ── nearest-match suggestion (tier-2 hint only) ──────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let cur = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]
}

/** A gentle hint for a dead link: a stem that contains / is contained by the target,
 *  else the closest stem within a small edit distance. Never auto-applied. */
function suggestStem(target: string, stems: Set<string>): string | undefined {
  const lc = target.toLowerCase()
  let containment: string | undefined
  for (const s of stems) {
    const sl = s.toLowerCase()
    if (sl === lc) continue
    if (sl.includes(lc) || lc.includes(sl)) {
      if (!containment || s.length < containment.length) containment = s
    }
  }
  if (containment) return containment
  let best: string | undefined
  let bestD = Infinity
  for (const s of stems) {
    const d = levenshtein(lc, s.toLowerCase())
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best !== undefined && bestD <= 2 ? best : undefined
}

// ── checks ───────────────────────────────────────────────────────────────────

// 1 — dead wikilinks. Topics + INDEX → error; conversations → warning (append-only
// logs, lower stakes, and they hold the bulk of historical links).
function checkDeadWikilinks(m: KbModel, find: (f: LintFinding) => void): void {
  const allStems = new Set<string>([...m.topicStems])
  for (const f of [...m.conversations, ...m.raw]) allStems.add(f.stem)

  const scan = (file: MdFile, severity: Severity) => {
    for (const link of extractLinks(file.body)) {
      if (link.target === '' || m.resolvable.has(link.target)) continue
      find({
        check: 'dead-wikilink',
        severity,
        file: file.rel,
        message: 'wikilink resolves to no topic / conversation / raw file',
        detail: `[[${link.rawText}]]`,
        suggestion: suggestStem(link.target, allStems),
      })
    }
  }
  for (const t of m.topics) scan(t, 'error')
  for (const c of m.conversations) scan(c, 'warning')
  // INDEX dead links (dangling catalog entries) are errors.
  for (const link of m.indexLinks) {
    if (link.target === '' || m.resolvable.has(link.target)) continue
    find({
      check: 'dead-wikilink',
      severity: 'error',
      file: 'INDEX.md',
      message: 'INDEX wikilink resolves to no existing topic/file',
      detail: `[[${link.rawText}]]`,
      suggestion: suggestStem(link.target, allStems),
    })
  }
}

// 2 — orphan topics. A topic referenced by no OTHER topic (body wikilink or `related:`).
// INDEX-independent on purpose (a minimal INDEX links no topics → would mark all orphan).
function checkOrphanTopics(m: KbModel, find: (f: LintFinding) => void): void {
  const referenced = new Set<string>()
  for (const t of m.topics) {
    const selfNames = new Set([t.stem, typeof t.data.title === 'string' ? (t.data.title as string) : ''])
    for (const link of extractLinks(t.body)) {
      if (!selfNames.has(link.target)) referenced.add(link.target)
    }
    for (const r of asStringArray(t.data.related)) referenced.add(normalizeTarget(r))
    // `parent:` is an inbound edge too: a sub-topic carrying `parent: <hub>.md` references
    // its hub. Without this a hub reachable only via its sub-topics looks (wrongly) orphan.
    if (typeof t.data.parent === 'string') referenced.add(normalizeTarget(t.data.parent as string))
  }
  for (const t of m.topics) {
    const title = typeof t.data.title === 'string' ? (t.data.title as string) : ''
    if (referenced.has(t.stem) || (title && referenced.has(title))) continue
    // INVARIANT (owner rule): ONLY meta/noise-tagged topics may be orphans. They are
    // archival sinks (e.g. noise-spawn-handshake) that are SUPPOSED to have no inbound
    // links; everything else MUST be cross-linked or it is reported here.
    const tags = asStringArray(t.data.tags)
    if (tags.includes('meta') || tags.includes('noise')) continue
    find({
      check: 'orphan-topic',
      severity: 'warning',
      file: t.rel,
      message: 'topic is not cross-linked by any other topic (reachable only via search)',
    })
  }
}

// 3 — INDEX drift. Only the "topic on disk but missing from INDEX" direction, and only
// for a catalog-style INDEX (a minimal INDEX suppresses it by design). Dangling INDEX
// entries are handled as dead links in check 1.
function checkIndexDrift(m: KbModel, style: string, find: (f: LintFinding) => void): void {
  if (style !== 'catalog') return
  const linked = new Set(m.indexLinks.map(l => l.target))
  for (const t of m.topics) {
    const title = typeof t.data.title === 'string' ? (t.data.title as string) : ''
    if (linked.has(t.stem) || (title && linked.has(title))) continue
    find({
      check: 'index-drift',
      severity: 'warning',
      file: 'INDEX.md',
      message: 'topic exists on disk but is missing from the catalog INDEX',
      detail: t.stem,
    })
  }
}

// 4 — bad / invisible frontmatter. Parse failure → error (dropped from kb_list_topics).
// Missing title / description → warning (degraded display). Duplicate title → warning
// (resolveTitleToStem returns the first, shadowing the rest).
function checkFrontmatter(m: KbModel, find: (f: LintFinding) => void): void {
  const titleOwners = new Map<string, string[]>()
  for (const t of m.topics) {
    if (t.parseError) {
      find({
        check: 'bad-frontmatter',
        severity: 'error',
        file: t.rel,
        message: 'frontmatter unparseable — silently dropped from kb_list_topics',
        detail: t.parseError,
      })
      continue
    }
    const title = t.data.title
    if (typeof title !== 'string' || title.trim() === '') {
      find({
        check: 'bad-frontmatter',
        severity: 'warning',
        file: t.rel,
        message: 'missing `title:` — kb_list_topics falls back to the filename stem',
        detail: typeof t.data.name === 'string' ? 'has `name:` instead of `title:`' : undefined,
      })
    } else {
      const list = titleOwners.get(title) ?? []
      list.push(t.rel)
      titleOwners.set(title, list)
    }
    const desc = t.data.description
    if (typeof desc !== 'string' || desc.trim() === '') {
      find({
        check: 'bad-frontmatter',
        severity: 'warning',
        file: t.rel,
        message: 'missing `description:` — blank in kb_list_topics',
      })
    }
  }
  for (const [title, owners] of titleOwners) {
    if (owners.length > 1) {
      find({
        check: 'bad-frontmatter',
        severity: 'warning',
        file: owners[0],
        message: `duplicate title "${title}" across ${owners.length} files — title→stem resolution shadows all but one`,
        detail: owners.join(', '),
      })
    }
  }
}

// 5 — raw ↔ topic linkage. (a) raw.topics naming a nonexistent topic → warning.
// (b) distilled raw with no back-ref (empty/absent topics) → info (half the corpus;
// surfacing the provenance gap is the point, but it is not an error).
function checkRawLinkage(m: KbModel, find: (f: LintFinding) => void): void {
  const topicNames = new Set<string>([...m.topicStems, ...m.topicTitles])
  const convStems = new Set(m.conversations.map(c => c.stem))
  for (const r of m.raw) {
    if (r.parseError) continue // a raw with broken frontmatter is its own (rare) issue; skip linkage
    const declared = asStringArray(r.data.topics)
    for (const name of declared) {
      const norm = normalizeTarget(name)
      if (topicNames.has(norm) || topicNames.has(name)) continue // resolves to a real topic
      // Schema violation: `topics:` may ONLY name topics. A conversation ref
      // (topics: [conversations/<date>]) points at the daily log — distinct, clearer message.
      if (/^conversations\//.test(name.trim()) || convStems.has(norm)) {
        find({
          check: 'raw-topics-not-a-topic',
          severity: 'warning',
          file: r.rel,
          message: 'raw `topics:` points at a conversation, not a topic (schema violation — must name a topic)',
          detail: name,
        })
      } else {
        find({
          check: 'raw-dangling-topic',
          severity: 'warning',
          file: r.rel,
          message: 'raw `topics:` names a topic that does not exist',
          detail: name,
          suggestion: suggestStem(norm, m.topicStems),
        })
      }
    }
    const distilled = r.data.distilled === true
    if (distilled && declared.length === 0) {
      find({
        check: 'raw-no-backref',
        severity: 'info',
        file: r.rel,
        message: 'distilled raw has no `topics:` back-ref — provenance link missing',
      })
    }
  }
}

// ── stats (the full-picture counts) ─────────────────────────────────────────

const NOISE_TOPIC = 'noise-spawn-handshake'

function computeStats(m: KbModel, findings: LintFinding[]): LintStats {
  let total = 0
  let resolved = 0
  const countIn = (files: MdFile[]) => {
    for (const f of files) {
      for (const l of extractLinks(f.body)) {
        total++
        if (l.target && m.resolvable.has(l.target)) resolved++
      }
    }
  }
  countIn(m.topics)
  countIn(m.conversations)
  for (const l of m.indexLinks) {
    total++
    if (l.target && m.resolvable.has(l.target)) resolved++
  }

  const topicNames = new Set<string>([...m.topicStems, ...m.topicTitles])
  let rawDistilled = 0
  let rawUndistilled = 0
  let rawWithValidBackref = 0
  let rawNoise = 0
  let rawEmptyBackref = 0
  let rawDanglingBackref = 0
  for (const r of m.raw) {
    if (r.parseError) continue
    const distilled = r.data.distilled === true
    if (distilled) rawDistilled++
    else rawUndistilled++
    const declared = asStringArray(r.data.topics)
    const norm = declared.map(t => normalizeTarget(t))
    const valid = declared.filter((t, i) => topicNames.has(norm[i]) || topicNames.has(t))
    if (valid.length > 0) rawWithValidBackref++
    if (norm.includes(NOISE_TOPIC)) rawNoise++
    if (distilled && declared.length === 0) rawEmptyBackref++
    if (declared.length > 0 && valid.length < declared.length) rawDanglingBackref++
  }

  return {
    topics: m.topics.length,
    conversations: m.conversations.length,
    raw: m.raw.length,
    wikilinks: { total, resolved, broken: total - resolved },
    orphanTopics: findings.filter(f => f.check === 'orphan-topic').length,
    rawDistilled,
    rawUndistilled,
    rawWithValidBackref,
    rawNoise,
    rawEmptyBackref,
    rawDanglingBackref,
  }
}

// 6 — stale / undistilled raw. Scans the WHOLE corpus from the start: any raw that is
// not distilled: true is a backlog item — captured but never mined into topics, so its
// knowledge is uncaptured. (This is the gap a distill stall leaves; it is invisible to
// the back-ref checks, which only look at already-distilled raws.)
function checkUndistilledRaw(m: KbModel, find: (f: LintFinding) => void): void {
  for (const r of m.raw) {
    if (r.parseError) continue
    if (r.data.distilled === true) continue
    find({
      check: 'raw-undistilled',
      severity: 'warning',
      file: r.rel,
      message: 'raw is not distilled (distilled: false) — captured but never mined into topics',
    })
  }
}

// ── orchestrator ─────────────────────────────────────────────────────────────

export interface LintOptions {
  /** Limit to these check ids (default: all). */
  checks?: string[]
}

export function lintKb(kbPath: string, opts: LintOptions = {}): LintReport {
  const m = buildModel(kbPath)
  const style = indexStyleOf(m)
  const findings: LintFinding[] = []
  const find = (f: LintFinding) => findings.push(f)

  const enabled = (id: string) => !opts.checks || opts.checks.includes(id)
  if (enabled('dead-wikilink')) checkDeadWikilinks(m, find)
  if (enabled('orphan-topic')) checkOrphanTopics(m, find)
  if (enabled('index-drift')) checkIndexDrift(m, style, find)
  if (enabled('bad-frontmatter')) checkFrontmatter(m, find)
  if (enabled('raw-linkage')) checkRawLinkage(m, find)
  if (enabled('raw-undistilled')) checkUndistilledRaw(m, find)

  const counts = { error: 0, warning: 0, info: 0 }
  const byCheck: Record<string, number> = {}
  for (const f of findings) {
    counts[f.severity]++
    byCheck[f.check] = (byCheck[f.check] ?? 0) + 1
  }
  const exitCode: 0 | 1 | 2 = counts.error > 0 ? 2 : counts.warning > 0 ? 1 : 0

  return {
    kbPath,
    scale: { topics: m.topics.length, conversations: m.conversations.length, raw: m.raw.length },
    indexStyle: style,
    stats: computeStats(m, findings),
    findings,
    counts,
    byCheck,
    exitCode,
  }
}

/**
 * `--fix`: regenerate a CATALOG INDEX from disk (the one deterministic-safe repair).
 * Refuses on a minimal/absent INDEX so it never clobbers a deliberately-minimal index.
 * Returns a short status string; does NOT touch any topic content.
 */
export function fixIndex(kbPath: string): { fixed: boolean; reason: string } {
  const m = buildModel(kbPath)
  const style = indexStyleOf(m)
  if (style !== 'catalog') {
    return { fixed: false, reason: `INDEX is ${style} — not a topic catalog; --fix leaves it untouched` }
  }
  // Reuse the store's catalog generator so the format stays identical.
  const store = new KnowledgeStore(kbPath)
  store.updateIndex()
  return { fixed: true, reason: 'INDEX.md regenerated from disk (catalog style)' }
}
