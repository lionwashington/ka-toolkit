import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import { serializeWithFrontmatter } from '../knowledge-store/markdown.js'

export interface SplitResult {
  split: boolean
  reason: 'under-threshold' | 'no-boundary-found' | 'split'
  cutLineIndex?: number
  mainFinalLines?: number
  partFilePath?: string
  partFinalLines?: number
  partNumber?: number
  chained?: SplitResult
}

export interface SplitOptions {
  threshold?: number
  maxChainDepth?: number
}

// Bilingual: matches both the English `## Thread N:` heading (default for new
// logs) and the legacy Chinese `## 主线 N:` — so older captured logs still split.
const HEADING_RE = /^## (Thread|主线) /

export function splitDailyLog(filePath: string, opts: SplitOptions = {}): SplitResult {
  const threshold = opts.threshold ?? 1000
  const maxDepth = opts.maxChainDepth ?? 5
  return splitOnce(filePath, threshold, maxDepth)
}

function splitOnce(filePath: string, threshold: number, depthLeft: number): SplitResult {
  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === ''
  const lineCount = trailingNewline ? lines.length - 1 : lines.length

  if (lineCount <= threshold) {
    return { split: false, reason: 'under-threshold' }
  }

  // Find the last `## Thread `/`## 主线 ` heading at or before line index = threshold - 1.
  let cutIndex = -1
  const searchEnd = Math.min(threshold, lines.length) - 1
  for (let i = searchEnd; i >= 0; i--) {
    if (HEADING_RE.test(lines[i])) {
      cutIndex = i
      break
    }
  }

  let fallback = false
  if (cutIndex < 0) {
    cutIndex = threshold
    fallback = true
  }

  const dir = dirname(filePath)
  const fileBase = basename(filePath, '.md')
  const dateMatch = fileBase.match(/^(\d{4}-\d{2}-\d{2})/)
  if (!dateMatch) {
    throw new Error(`splitDailyLog: filename does not start with YYYY-MM-DD: ${filePath}`)
  }
  const datePrefix = dateMatch[1]

  // Find next part number by scanning the directory.
  const existingParts: number[] = []
  for (const f of readdirSync(dir)) {
    const m = f.match(new RegExp(`^${datePrefix}-part(\\d+)\\.md$`))
    if (m) existingParts.push(Number(m[1]))
  }
  const nextPart = existingParts.length === 0 ? 2 : Math.max(...existingParts) + 1
  const partFileName = `${datePrefix}-part${nextPart}.md`
  const partFilePath = join(dir, partFileName)

  // Slice
  const mainLines = lines.slice(0, cutIndex)
  const partSlice = lines.slice(cutIndex, trailingNewline ? lines.length - 1 : lines.length)

  // Trim trailing whitespace on main, then append cross-link.
  while (mainLines.length > 0 && mainLines[mainLines.length - 1].trim() === '') {
    mainLines.pop()
  }
  const mainTrailer = ['', '---', '', `→ continued [[${datePrefix}-part${nextPart}]]`, '']
  const newMainContent = mainLines.concat(mainTrailer).join('\n')

  // Part file: build fresh frontmatter + back-link line + the slice.
  const parentBase = fileBase
  const isSplittingMain = parentBase === datePrefix
  const backLink = isSplittingMain
    ? `← [[${datePrefix}]] (main file has TL;DR)`
    : `← [[${parentBase}]] (previous part) | [[${datePrefix}]] (main file has TL;DR)`
  const partFrontmatter: Record<string, unknown> = {
    title: `${datePrefix} daily (part ${nextPart})`,
    date: datePrefix,
    tags: ['daily'],
    part: nextPart,
    parent: `${parentBase}.md`,
  }
  const partBody = `${backLink}\n\n${partSlice.join('\n').replace(/\n+$/, '')}\n`
  const newPartContent = serializeWithFrontmatter(partFrontmatter, partBody)

  writeFileSync(filePath, newMainContent, 'utf-8')
  writeFileSync(partFilePath, newPartContent, 'utf-8')

  const mainFinalLines = newMainContent.split('\n').length - (newMainContent.endsWith('\n') ? 1 : 0)
  const partFinalLines = newPartContent.split('\n').length - (newPartContent.endsWith('\n') ? 1 : 0)

  const result: SplitResult = {
    split: true,
    reason: fallback ? 'no-boundary-found' : 'split',
    cutLineIndex: cutIndex,
    mainFinalLines,
    partFilePath,
    partFinalLines,
    partNumber: nextPart,
  }

  if (depthLeft > 1 && partFinalLines > threshold) {
    result.chained = splitOnce(partFilePath, threshold, depthLeft - 1)
  }

  return result
}
