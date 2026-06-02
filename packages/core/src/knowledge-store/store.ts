import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { parseFrontmatter, serializeWithFrontmatter } from './markdown.js'
import type { KnowledgeRetrieval } from '../retrieval/retrieval.js'
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
  private retrieval: KnowledgeRetrieval | null = null

  constructor(basePath: string) {
    this.basePath = basePath
  }

  setRetrieval(retrieval: KnowledgeRetrieval): void {
    this.retrieval = retrieval
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

  readTopic(name: string): Topic {
    const safeName = sanitizeTopicName(name)
    const filePath = join(this.topicsDir, `${safeName}.md`)
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

    if (this.retrieval) {
      this.retrieval.indexAll().catch(() => {})
    }
  }
}
