import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { parseFrontmatter, serializeWithFrontmatter } from '../knowledge-store/markdown.js'

const HUB_INDEX_MARKER = '<!-- sub-topic-index: managed by ka-split-topic — do NOT edit manually -->'

export interface SubTopicSpec {
  /** Slug used in the sub-topic filename: `<topic>-<name>.md`. */
  name: string
  /** Human-readable title shown in the hub index AND the sub-topic file's own frontmatter. */
  title: string
  /** Optional one-line description shown in the hub index. */
  description?: string
  /**
   * Exact `## ` heading strings (with hashes) to move into this sub-topic.
   * Match is done after trimming whitespace; comparison is strict otherwise.
   */
  headings: string[]
}

export interface SplitPlan {
  subTopics: SubTopicSpec[]
}

export interface SplitOptions {
  /** Allow overwriting existing sub-topic files. Default false → throw on conflict. */
  force?: boolean
  /**
   * Soft threshold (lines). Splitter doesn't refuse to run when the file is
   * below threshold, but does emit `belowThreshold: true` in the result so
   * the caller can warn.
   */
  threshold?: number
}

export interface SplitTopicResult {
  hubFilePath: string
  hubLines: number
  belowThreshold: boolean
  subTopicsWritten: Array<{
    name: string
    filePath: string
    lines: number
    sectionCount: number
  }>
  unmovedHeadings: string[]
}

interface Section {
  /** Full heading line, including the `## ` prefix. */
  heading: string
  /** Body lines (everything between this heading and the next `## ` / EOF), trailing newlines stripped. */
  body: string
}

export function splitTopic(topicFilePath: string, plan: SplitPlan, opts: SplitOptions = {}): SplitTopicResult {
  if (!existsSync(topicFilePath)) {
    throw new Error(`splitTopic: topic file not found: ${topicFilePath}`)
  }
  const threshold = opts.threshold ?? 500
  const fileBase = basename(topicFilePath, '.md')

  // --- validate plan ------------------------------------------------------
  if (plan.subTopics.length === 0) {
    throw new Error('splitTopic: plan.subTopics is empty — nothing to do')
  }
  const seenNames = new Set<string>()
  const seenHeadings = new Set<string>()
  for (const st of plan.subTopics) {
    if (!/^[a-z0-9-]+$/.test(st.name)) {
      throw new Error(`splitTopic: sub-topic name "${st.name}" must match [a-z0-9-]+`)
    }
    if (seenNames.has(st.name)) {
      throw new Error(`splitTopic: duplicate sub-topic name "${st.name}"`)
    }
    seenNames.add(st.name)
    if (st.headings.length === 0) {
      throw new Error(`splitTopic: sub-topic "${st.name}" has no headings — refusing empty spec`)
    }
    for (const h of st.headings) {
      const key = h.trim()
      if (seenHeadings.has(key)) {
        throw new Error(`splitTopic: heading "${h}" appears in multiple sub-topics`)
      }
      seenHeadings.add(key)
    }
  }

  // --- parse topic file ---------------------------------------------------
  const raw = readFileSync(topicFilePath, 'utf-8')
  const { data, content } = parseFrontmatter(raw)
  const cleaned = stripExistingHubIndex(content)
  const { preamble, sections: hubSectionsOnly } = parseSections(cleaned)

  // --- merge sections from existing sub-topic files (idempotent re-run) ---
  // When force:true, the caller may be re-applying the same plan against an
  // already-split hub. In that case the hub no longer contains the moved
  // headings — they live in the sub-topic files. To make `force` a true
  // idempotent re-split, we read those files and merge their sections back
  // into the working set before validating the plan.
  const dir = dirname(topicFilePath)
  const sections: Section[] = [...hubSectionsOnly]
  if (opts.force) {
    const existingSubTopics = (data.sub_topics as Array<{ name?: unknown }> | undefined) ?? []
    for (const st of existingSubTopics) {
      if (typeof st !== 'object' || st === null || typeof (st as { name?: unknown }).name !== 'string') continue
      const subFile = join(dir, `${fileBase}-${(st as { name: string }).name}.md`)
      if (!existsSync(subFile)) continue
      try {
        const subRaw = readFileSync(subFile, 'utf-8')
        const { content: subBody } = parseFrontmatter(subRaw)
        const { sections: subSecs } = parseSections(subBody)
        sections.push(...subSecs)
      } catch { /* skip — sub-topic file unreadable */ }
    }
  }

  // --- match plan against sections ---------------------------------------
  const headingMap = new Map<string, number>()
  sections.forEach((s, i) => headingMap.set(s.heading.trim(), i))

  const missing: string[] = []
  for (const st of plan.subTopics) {
    for (const h of st.headings) {
      if (!headingMap.has(h.trim())) missing.push(`${st.name}: ${h}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`splitTopic: ${missing.length} heading(s) in plan not found in ${fileBase}.md:\n  - ${missing.join('\n  - ')}`)
  }

  // --- check existing sub-topic files ------------------------------------
  if (!opts.force) {
    const conflicts: string[] = []
    for (const st of plan.subTopics) {
      const p = join(dir, `${fileBase}-${st.name}.md`)
      if (existsSync(p)) conflicts.push(p)
    }
    if (conflicts.length > 0) {
      throw new Error(`splitTopic: sub-topic file(s) already exist (pass force:true to overwrite):\n  - ${conflicts.join('\n  - ')}`)
    }
  }

  // --- compute writes ----------------------------------------------------
  const movedHeadings = new Set<string>()
  const written: SplitTopicResult['subTopicsWritten'] = []

  for (const st of plan.subTopics) {
    const subSections: Section[] = []
    for (const h of st.headings) {
      const idx = headingMap.get(h.trim())!
      subSections.push(sections[idx])
      movedHeadings.add(h.trim())
    }
    const subPath = join(dir, `${fileBase}-${st.name}.md`)
    const subContent = renderSubTopicFile(fileBase, st, subSections)
    writeFileSync(subPath, subContent, 'utf-8')
    written.push({
      name: st.name,
      filePath: subPath,
      lines: countLines(subContent),
      sectionCount: subSections.length,
    })
  }

  // --- rewrite hub --------------------------------------------------------
  const hubSections = sections.filter(s => !movedHeadings.has(s.heading.trim()))
  const unmovedHeadings = hubSections.map(s => s.heading)
  const hubContent = renderHubFile(data, preamble, plan, hubSections, fileBase)
  writeFileSync(topicFilePath, hubContent, 'utf-8')

  const hubLines = countLines(hubContent)
  return {
    hubFilePath: topicFilePath,
    hubLines,
    belowThreshold: hubLines <= threshold,
    subTopicsWritten: written,
    unmovedHeadings,
  }
}

function parseSections(body: string): { preamble: string; sections: Section[] } {
  const lines = body.split('\n')
  const preambleLines: string[] = []
  const sections: Section[] = []
  let current: { heading: string; body: string[] } | null = null
  for (const line of lines) {
    // Match exactly two leading hashes (not ###).
    if (/^## /.test(line) && !/^### /.test(line)) {
      if (current) {
        sections.push({ heading: current.heading, body: current.body.join('\n').replace(/\n+$/, '') })
      }
      current = { heading: line, body: [] }
    } else if (current) {
      current.body.push(line)
    } else {
      preambleLines.push(line)
    }
  }
  if (current) {
    sections.push({ heading: current.heading, body: current.body.join('\n').replace(/\n+$/, '') })
  }
  return { preamble: preambleLines.join('\n').replace(/\n+$/, ''), sections }
}

function stripExistingHubIndex(content: string): string {
  // If a previous splitter run left a managed sub-topic index, remove it so
  // we can rewrite cleanly. The block is bounded by the marker comment.
  const idx = content.indexOf(HUB_INDEX_MARKER)
  if (idx < 0) return content
  const endMarker = '<!-- /sub-topic-index -->'
  const endIdx = content.indexOf(endMarker, idx)
  if (endIdx < 0) return content  // malformed — leave alone to avoid data loss
  const after = endIdx + endMarker.length
  return (content.slice(0, idx) + content.slice(after)).replace(/\n{3,}/g, '\n\n')
}

function renderHubFile(
  data: Record<string, unknown>,
  preamble: string,
  plan: SplitPlan,
  hubSections: Section[],
  fileBase: string,
): string {
  // Build the sub-topic index block. It's idempotently regenerated each run.
  const indexLines: string[] = [
    '',
    HUB_INDEX_MARKER,
    '',
    '## Sub-Topic Index',
    '',
  ]
  for (const st of plan.subTopics) {
    const link = `[[${fileBase}-${st.name}]]`
    if (st.description) {
      indexLines.push(`- ${link} — **${st.title}**：${st.description}`)
    } else {
      indexLines.push(`- ${link} — **${st.title}**`)
    }
  }
  indexLines.push('')
  indexLines.push('> The main file keeps cross-cutting content; see the per-sub-topic files above for details.')
  indexLines.push('')
  indexLines.push('<!-- /sub-topic-index -->')
  indexLines.push('')

  const sectionsText = hubSections.map(s => `${s.heading}\n${s.body}`.replace(/\n+$/, '')).join('\n\n')
  const body = [
    preamble.replace(/\n+$/, ''),
    indexLines.join('\n').replace(/^\n+/, ''),
    sectionsText,
  ].filter(Boolean).join('\n\n') + '\n'

  // Update frontmatter: add sub_topics array
  const newData = { ...data }
  newData.sub_topics = plan.subTopics.map(st => ({
    name: st.name,
    title: st.title,
    ...(st.description ? { description: st.description } : {}),
  }))

  return serializeWithFrontmatter(newData, body)
}

function renderSubTopicFile(parentBase: string, st: SubTopicSpec, sections: Section[]): string {
  const frontmatter: Record<string, unknown> = {
    title: st.title,
    parent: `${parentBase}.md`,
    sub_topic: st.name,
    tags: ['topic'],
  }
  if (st.description) frontmatter.description = st.description

  const lead = `← [[${parentBase}]] (main file hub — contains the sub-topic index)\n`
  const descBlock = st.description ? `\n> ${st.description}\n` : ''
  const sectionsText = sections.map(s => `${s.heading}\n${s.body}`.replace(/\n+$/, '')).join('\n\n')
  const body = `${lead}${descBlock}\n${sectionsText}\n`
  return serializeWithFrontmatter(frontmatter, body)
}

function countLines(s: string): number {
  if (s.length === 0) return 0
  const n = s.split('\n').length
  return s.endsWith('\n') ? n - 1 : n
}
