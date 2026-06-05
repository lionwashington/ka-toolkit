import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { parseFrontmatter, serializeWithFrontmatter } from './markdown.js'
import type { Topic, TopicSummary } from './types.js'

function sanitizeTopicName(name: string): string {
  if (!name || !name.trim()) {
    throw new Error('Topic name cannot be empty')
  }
  if (/[/\\]|\.\./.test(name)) {
    throw new Error(`Invalid topic name: ${name}`)
  }
  return name.replace(/[<>:"|?*\x00-\x1f]/g, '_')
}

export class KnowledgeStore {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  get root(): string {
    return this.basePath
  }

  get topicsDir(): string {
    return join(this.basePath, 'topics')
  }

  get conversationsDir(): string {
    return join(this.basePath, 'conversations')
  }

  get rawDir(): string {
    return join(this.basePath, 'raw')
  }

  get indexPath(): string {
    return join(this.basePath, 'INDEX.md')
  }

  init(): void {
    mkdirSync(this.topicsDir, { recursive: true })
    mkdirSync(this.conversationsDir, { recursive: true })
    mkdirSync(this.rawDir, { recursive: true })
    mkdirSync(join(this.basePath, 'pending-topics'), { recursive: true })

    if (!existsSync(this.indexPath)) {
      const data = { updated: new Date().toISOString().slice(0, 10) }
      const body = `# Knowledge Base Index\n\n## Topics\n\n_No topics yet._\n\n## Stats\n\n- Total conversations: 0\n- Total topics: 0`
      writeFileSync(this.indexPath, serializeWithFrontmatter(data, body), 'utf-8')
    }
  }

  writeTopic(topic: Topic): void {
    const safeName = sanitizeTopicName(topic.name)
    const data = {
      title: topic.name,
      description: topic.description,
      created: topic.created,
      updated: topic.updated,
      tags: topic.tags,
      ...(topic.relatedTopics?.length ? { related: topic.relatedTopics } : {}),
    }
    const filePath = join(this.topicsDir, `${safeName}.md`)
    writeFileSync(filePath, serializeWithFrontmatter(data, topic.content), 'utf-8')
  }

  // Resolve a frontmatter `title` to its filename stem. kb_list_topics shows the title
  // (e.g. "Todo List") but files are named by stem (e.g. todo.md); a caller using the
  // displayed title would otherwise miss. Scan-on-miss (fallback path, not hot); first exact-title
  // match wins (stems are unique — callers should prefer the stem to be unambiguous).
  private resolveTitleToStem(title: string): string | null {
    if (!existsSync(this.topicsDir)) return null
    for (const f of readdirSync(this.topicsDir)) {
      if (!f.endsWith('.md')) continue
      try {
        const { data } = parseFrontmatter(readFileSync(join(this.topicsDir, f), 'utf-8'))
        if ((data.title as string) === title) return f.replace(/\.md$/, '')
      } catch {
        // skip unreadable/malformed file
      }
    }
    return null
  }

  readTopic(name: string): Topic {
    const safeName = sanitizeTopicName(name)
    let filePath = join(this.topicsDir, `${safeName}.md`)
    // Accept BOTH the filename stem (fast path / current behavior) AND the display title:
    // if no file matches the stem, try resolving `name` as a frontmatter title.
    if (!existsSync(filePath)) {
      const stem = this.resolveTitleToStem(name)
      if (stem) filePath = join(this.topicsDir, `${stem}.md`)
    }
    const raw = readFileSync(filePath, 'utf-8')
    const { data, content } = parseFrontmatter(raw)

    return {
      name: (data.title as string) ?? name,
      description: (data.description as string) ?? '',
      created: (data.created as string) ?? '',
      updated: (data.updated as string) ?? '',
      tags: (data.tags as string[]) ?? [],
      content: content.trim(),
      relatedTopics: (data.related as string[]) ?? undefined,
    }
  }

  listTopics(): TopicSummary[] {
    if (!existsSync(this.topicsDir)) return []

    return readdirSync(this.topicsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try {
          const name = f.replace(/\.md$/, '')
          const topic = this.readTopic(name)
          return { name: topic.name, description: topic.description }
        } catch {
          return null
        }
      })
      .filter((t): t is TopicSummary => t !== null)
  }

  appendToTopic(name: string, content: string, newTags?: string[]): void {
    const topic = this.readTopic(name)
    topic.content = topic.content + content
    topic.updated = new Date().toISOString().slice(0, 10)
    if (newTags) {
      const tagSet = new Set([...topic.tags, ...newTags])
      topic.tags = [...tagSet]
    }
    this.writeTopic(topic)
  }

  /**
   * Update INDEX.md to match current topics, and rebuild RAG search index.
   */
  updateIndex(): void {
    const topics = this.listTopics()

    const data: Record<string, unknown> = {
      updated: new Date().toISOString().slice(0, 10),
    }

    const topicLines = topics.length > 0
      ? topics.map(t => `- [[topics/${t.name}|${t.name}]] — ${t.description}`).join('\n')
      : '_No topics yet._'

    const body = `# Knowledge Base Index\n\n## Topics\n\n${topicLines}`

    writeFileSync(this.indexPath, serializeWithFrontmatter(data, body), 'utf-8')
    // The LanceDB index is rebuilt out-of-band by `ka kb reindex` / the distill
    // increment, not synchronously on topic save — so no in-process reindex hook here.
  }
}
