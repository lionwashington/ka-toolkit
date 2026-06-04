import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { parseFrontmatter, serializeWithFrontmatter } from '../knowledge-store/markdown.js'
import type { Conversation, ConversationMessage, ParseProgress } from './types.js'

export class ConversationCapture {
  private dir: string

  constructor(conversationsDir: string) {
    this.dir = conversationsDir
    mkdirSync(this.dir, { recursive: true })
  }

  private filename(conv: Conversation): string {
    const date = conv.timestamp.slice(0, 10)
    return `${date}-${conv.id}.md`
  }

  save(conv: Conversation): void {
    // Dedup: if a conversation with the same sessionId already exists, overwrite it
    const existing = this.findBySessionId(conv.sessionId)

    // Preserve distilled/topics state + parseProgress from existing file
    let existingDistilled = false
    let existingTopics: string[] = []
    let existingProgress: ParseProgress | undefined
    if (existing) {
      try {
        const raw = readFileSync(existing.path, 'utf-8')
        const { data: existingData } = parseFrontmatter(raw)
        existingDistilled = existingData.distilled as boolean ?? false
        existingTopics = existingData.topics as string[] ?? []
        existingProgress = readProgressFromFrontmatter(existingData)
      } catch { /* use defaults */ }
    }

    const data: Record<string, unknown> = {
      id: existing?.id ?? conv.id,
      source: conv.source,
      session_id: conv.sessionId,
      timestamp: conv.timestamp,
      distilled: existingDistilled,
      topics: existingTopics,
    }
    if (conv.metadata) {
      data.metadata = conv.metadata
    }

    const progress = conv.parseProgress ?? existingProgress
    if (progress) writeProgressToFrontmatter(data, progress)

    const body = conv.messages
      .map(m => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`)
      .join('\n\n')

    const filePath = existing?.path ?? join(this.dir, this.filename(conv))
    writeFileSync(filePath, serializeWithFrontmatter(data, body), 'utf-8')
  }

  updateParseProgress(id: string, progress: ParseProgress): void {
    const file = readdirSync(this.dir).find(f => f.endsWith(`-${id}.md`))
    if (!file) return
    const filePath = join(this.dir, file)
    const raw = readFileSync(filePath, 'utf-8')
    const { data, content } = parseFrontmatter(raw)
    writeProgressToFrontmatter(data, progress)
    writeFileSync(filePath, serializeWithFrontmatter(data, content), 'utf-8')
  }

  readParseProgress(id: string): ParseProgress | null {
    const file = readdirSync(this.dir).find(f => f.endsWith(`-${id}.md`))
    if (!file) return null
    const filePath = join(this.dir, file)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const { data } = parseFrontmatter(raw)
      return readProgressFromFrontmatter(data) ?? null
    } catch {
      return null
    }
  }

  private findBySessionId(sessionId: string): { id: string; path: string } | null {
    if (!sessionId || !existsSync(this.dir)) return null
    // Reverse order: newest files first (most likely to match current session)
    const files = readdirSync(this.dir).filter(f => f.endsWith('.md')).reverse()
    for (const f of files) {
      const filePath = join(this.dir, f)
      try {
        // Read only the frontmatter (first ~20 lines) instead of the entire file
        const fd = openSync(filePath, 'r')
        const buf = Buffer.alloc(1024)
        const bytesRead = readSync(fd, buf, 0, 1024, 0)
        closeSync(fd)
        const head = buf.toString('utf-8', 0, bytesRead)
        // Quick check: skip files that don't contain the session_id string at all
        if (!head.includes(sessionId)) continue
        const { data } = parseFrontmatter(readFileSync(filePath, 'utf-8'))
        if (data.session_id === sessionId) {
          return { id: data.id as string, path: filePath }
        }
      } catch {
        // skip
      }
    }
    return null
  }

  getUnprocessed(): Conversation[] {
    if (!existsSync(this.dir)) return []

    return readdirSync(this.dir)
      .filter(f => f.endsWith('.md'))
      .map(f => this.loadConversation(join(this.dir, f)))
      .filter(c => c !== null)
      .filter(c => !c.distilled)
  }

  markDistilled(id: string, topics: string[]): void {
    const file = readdirSync(this.dir).find(f => f.endsWith(`-${id}.md`))
    if (!file) return

    const filePath = join(this.dir, file)
    const raw = readFileSync(filePath, 'utf-8')
    const { data, content } = parseFrontmatter(raw)

    data.distilled = true
    data.topics = topics

    writeFileSync(filePath, serializeWithFrontmatter(data, content), 'utf-8')
  }

  loadConversationByPath(filePath: string): Conversation | null {
    const result = this.loadConversation(filePath)
    if (!result) return null
    const { distilled: _distilled, ...conv } = result
    void _distilled
    return conv
  }

  private loadConversation(filePath: string): (Conversation & { distilled: boolean }) | null {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const { data, content } = parseFrontmatter(raw)

      const messages: ConversationMessage[] = []
      const sections = content.split(/^## (User|Assistant)$/m).slice(1)

      for (let i = 0; i < sections.length; i += 2) {
        const role = sections[i].trim().toLowerCase() as 'user' | 'assistant'
        const text = (sections[i + 1] ?? '').trim()
        if (text) {
          messages.push({ role, content: text, timestamp: data.timestamp as string })
        }
      }

      const progress = readProgressFromFrontmatter(data)
      return {
        id: data.id as string,
        source: data.source as string,
        sessionId: data.session_id as string,
        timestamp: data.timestamp as string,
        messages,
        distilled: data.distilled as boolean,
        ...(progress ? { parseProgress: progress } : {}),
      }
    } catch {
      return null
    }
  }
}

function readProgressFromFrontmatter(data: Record<string, unknown>): ParseProgress | undefined {
  const offset = data.last_parsed_offset
  const uuid = data.last_parsed_message_id
  const count = data.last_parsed_message_count
  const at = data.last_parsed_at
  if (typeof offset !== 'number') return undefined
  return {
    offset,
    lastEntryUuid: typeof uuid === 'string' ? uuid : '',
    messageCount: typeof count === 'number' ? count : 0,
    parsedAt: typeof at === 'string' ? at : '',
  }
}

function writeProgressToFrontmatter(data: Record<string, unknown>, progress: ParseProgress): void {
  data.last_parsed_offset = progress.offset
  data.last_parsed_message_id = progress.lastEntryUuid
  data.last_parsed_message_count = progress.messageCount
  data.last_parsed_at = progress.parsedAt
}
