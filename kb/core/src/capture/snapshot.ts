import { readFileSync, realpathSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseFrontmatter, serializeWithFrontmatter } from '../knowledge-store/markdown.js'
import { atomicUpdateText, textHash } from './atomic-update.js'

export interface CaptureSnapshot {
  schema: 1
  source: 'codex'
  rawDir: string
  file: string
  id: string
  body: string
  hash: string
  processedPrefix: number
}

function rawPath(rawDir: string, file: string): string {
  if (basename(file) !== file || !file.endsWith('.md')) throw new Error('invalid raw basename')
  const root = realpathSync(rawDir)
  const path = realpathSync(join(root, file))
  if (dirname(path) !== root) throw new Error('raw path escapes root')
  return path
}

export function createCaptureSnapshot(rawDir: string, file: string, job: string): CaptureSnapshot {
  const { data, content } = parseFrontmatter(readFileSync(rawPath(rawDir, file), 'utf8'))
  if (data.source !== 'codex') throw new Error('snapshot command only accepts Codex captures; use the Claude workflow for Claude')
  if (typeof data.id !== 'string' || !data.id) throw new Error('missing capture id')
  const body = content.trim()
  const snapshot: CaptureSnapshot = { schema: 1, source: 'codex', rawDir: realpathSync(rawDir), file,
    id: String(data.id), body, hash: textHash(body), processedPrefix: Number(data.distilled_message_count ?? 0) }
  if (!Number.isSafeInteger(snapshot.processedPrefix) || snapshot.processedPrefix < 0 || snapshot.processedPrefix > body.split(/^## (?:User|Assistant)$/m).length - 1)
    throw new Error('invalid processed prefix')
  mkdirSync(dirname(resolve(job)), { recursive: true, mode: 0o700 })
  atomicUpdateText(resolve(job), existing => {
    if (existing !== null) throw new Error('snapshot job already exists; use a new job path')
    return JSON.stringify(snapshot) + '\n'
  })
  return snapshot
}

export function acknowledgeCaptureSnapshot(job: string, topics: string[]): { status: 'acknowledged' | 'unchanged' | 'conflict'; complete: boolean } {
  const snapshot = JSON.parse(readFileSync(job, 'utf8')) as CaptureSnapshot
  if (snapshot.schema !== 1 || snapshot.source !== 'codex' || typeof snapshot.body !== 'string' || textHash(snapshot.body) !== snapshot.hash)
    throw new Error('invalid capture snapshot')
  if (!Array.isArray(topics) || topics.some(t => typeof t !== 'string')) throw new Error('invalid topics')
  let status: 'acknowledged' | 'unchanged' | 'conflict' = 'conflict'
  let complete = false
  atomicUpdateText(rawPath(snapshot.rawDir, snapshot.file), raw => {
    complete = false
    if (raw === null) return null
    const { data, content } = parseFrontmatter(raw)
    const current = content.trim()
    if (data.source !== 'codex' || String(data.id) !== snapshot.id ||
      (current !== snapshot.body && !current.startsWith(snapshot.body + '\n\n## '))) {
      status = 'conflict'; return null
    }
    const count = snapshot.body.split(/^## (?:User|Assistant)$/m).length - 1
    if (Number(data.distilled_message_count ?? 0) >= count && data.distilled_content_hash) {
      complete = data.distilled === true
      status = 'unchanged'; return null
    }
    data.content_hash = textHash(current)
    data.distilled_content_hash = snapshot.hash
    data.distilled_message_count = count
    data.distilled = current === snapshot.body
    complete = data.distilled === true
    data.topics = [...new Set([...(Array.isArray(data.topics) ? data.topics : []), ...topics])]
    status = 'acknowledged'
    return serializeWithFrontmatter(data, content)
  })
  return { status, complete }
}
