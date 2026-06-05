// Chunk a topic markdown file into retrieval units, split by `## ` (H2) headings,
// parent/sub aware. Each chunk carries the raw text (for FTS + excerpt) and an
// `embedText` that prepends "topic › heading" context (improves embedding recall).
// The auto-generated "## Sub-Topic Index" section (managed by ka-split-topic) is
// excluded — it is just wikilinks and adds noise. Over-budget sections are
// sub-split by paragraph with a one-paragraph overlap.
import { parseFrontmatter } from '../knowledge-store/markdown.js'

// Keep in sync with kb/core/src/topics/splitter.ts.
const HUB_INDEX_MARKER =
  '<!-- sub-topic-index: managed by ka-split-topic — do NOT edit manually -->'

export interface Chunk {
  chunkIndex: number
  /** The `## ` section heading this chunk came from (`''` for the pre-heading intro). */
  heading: string
  /** Raw chunk text — indexed for FTS and returned as the excerpt. */
  text: string
  /** Text actually embedded: `"topic › heading\n\n<text>"` (context-prefixed). */
  embedText: string
  /** Rough token estimate (CJK char ≈ 1 token; ascii ≈ /4). */
  tokenEstimate: number
}

export interface ChunkTopicOptions {
  topic?: string
  /** Max tokens per chunk before a section is sub-split (default 500). */
  maxTokens?: number
}

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g

export function estimateTokens(s: string): number {
  const cjk = (s.match(CJK) || []).length
  const ascii = s.replace(CJK, '').trim()
  const asciiTokens = ascii ? ascii.split(/\s+/).filter(Boolean).length : 0
  return cjk + asciiTokens
}

interface Section {
  heading: string
  body: string
}

/** Drop the auto-generated Sub-Topic Index (everything from the marker on). */
function stripSubTopicIndex(content: string): string {
  const i = content.indexOf(HUB_INDEX_MARKER)
  return i >= 0 ? content.slice(0, i) : content
}

/** Split content into the pre-heading intro + one section per `## ` (H2) heading. */
function splitSections(content: string): Section[] {
  const lines = content.split('\n')
  const sections: Section[] = []
  let heading = ''
  let buf: string[] = []
  const flush = () => {
    const body = buf.join('\n').trim()
    if (body || heading) sections.push({ heading, body })
    buf = []
  }
  for (const line of lines) {
    if (/^## (?!#)/.test(line)) {
      flush()
      heading = line.replace(/^##\s+/, '').trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return sections
}

/** Accumulate paragraphs into <= maxTokens pieces, with a one-paragraph overlap. */
function packParagraphs(body: string, maxTokens: number): string[] {
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (paras.length === 0) return []
  const pieces: string[] = []
  let cur: string[] = []
  let curTok = 0
  for (const p of paras) {
    const t = estimateTokens(p)
    if (cur.length && curTok + t > maxTokens) {
      pieces.push(cur.join('\n\n'))
      cur = [cur[cur.length - 1]] // one-paragraph overlap
      curTok = estimateTokens(cur[0])
    }
    cur.push(p)
    curTok += t
  }
  if (cur.length) pieces.push(cur.join('\n\n'))
  return pieces
}

export function chunkTopic(raw: string, opts: ChunkTopicOptions = {}): Chunk[] {
  const topic = opts.topic ?? ''
  const maxTokens = opts.maxTokens ?? 500
  const { content } = parseFrontmatter(raw)
  const body = stripSubTopicIndex(content)

  const out: Chunk[] = []
  for (const sec of splitSections(body)) {
    if (sec.heading === 'Sub-Topic Index') continue
    const text = sec.body.trim()
    if (!text) continue
    const pieces =
      estimateTokens(text) > maxTokens ? packParagraphs(text, maxTokens) : [text]
    for (const piece of pieces) {
      if (!piece.trim()) continue
      const ctx = sec.heading ? `${topic} › ${sec.heading}` : topic
      out.push({
        chunkIndex: out.length,
        heading: sec.heading,
        text: piece,
        embedText: `${ctx}\n\n${piece}`,
        tokenEstimate: estimateTokens(piece),
      })
    }
  }
  return out
}
