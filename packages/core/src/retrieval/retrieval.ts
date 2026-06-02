import { create, insert, search, save, load } from '@orama/orama'
import type { AnyOrama } from '@orama/orama'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { parseFrontmatter } from '../knowledge-store/markdown.js'
import type { SearchOptions, SearchResult } from './types.js'

const SCHEMA = {
  title: 'string' as const,
  content: 'string' as const,
  path: 'string' as const,
  type: 'string' as const,
  description: 'string' as const,
}

// CJK Unicode ranges
const CJK_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\u20000-\u2A6DF\u2A700-\u2B73F\u2B740-\u2B81F\u2B820-\u2CEAF\uF900-\uFAFF\u2F800-\u2FA1F]/

function tokenizeMixed(input: string): string[] {
  const tokens: string[] = []
  const lower = input.toLowerCase()

  // Split on whitespace/punctuation, then handle CJK characters individually
  const segments = lower.split(/[\s\p{P}\p{S}]+/u).filter(Boolean)

  for (const segment of segments) {
    if (!segment) continue

    // Check if segment contains CJK characters
    if (CJK_REGEX.test(segment)) {
      // Add the full segment as a token (for multi-char matches)
      tokens.push(segment)
      // Also add individual CJK characters as tokens
      for (const char of segment) {
        if (CJK_REGEX.test(char)) {
          tokens.push(char)
        } else if (/\w/.test(char)) {
          tokens.push(char)
        }
      }
      // Add bigrams for better phrase matching
      for (let i = 0; i < segment.length - 1; i++) {
        const bigram = segment.slice(i, i + 2)
        if (CJK_REGEX.test(bigram[0])) {
          tokens.push(bigram)
        }
      }
    } else {
      tokens.push(segment)
    }
  }

  return Array.from(new Set(tokens)).filter(Boolean)
}

function createMixedTokenizer() {
  return {
    language: 'english',
    stemmer: undefined,
    stemmerSkipProperties: new Set<string>(),
    tokenizeSkipProperties: new Set<string>(),
    stopWords: [],
    allowDuplicates: false,
    normalizationCache: new Map<string, string>(),
    normalizeToken(_prop: string, token: string): string {
      return token
    },
    tokenize(input: string, _language?: string, _prop?: string): string[] {
      if (typeof input !== 'string') return [String(input)]
      return tokenizeMixed(input)
    },
  }
}

export class KnowledgeRetrieval {
  private basePath: string
  private db: AnyOrama | null = null
  private dbPromise: Promise<AnyOrama> | null = null
  private indexPath: string

  constructor(basePath: string) {
    this.basePath = basePath
    this.indexPath = join(basePath, '.vectors')
  }

  private async getDb(): Promise<AnyOrama> {
    if (this.db) return this.db
    if (this.dbPromise) return this.dbPromise

    this.dbPromise = this.initDb()
    return this.dbPromise
  }

  private async initDb(): Promise<AnyOrama> {
    const snapshotPath = join(this.indexPath, 'orama.json')
    if (existsSync(snapshotPath)) {
      const data = JSON.parse(readFileSync(snapshotPath, 'utf-8'))
      this.db = create({ schema: SCHEMA, components: { tokenizer: createMixedTokenizer() as any } })
      load(this.db, data)
    } else {
      this.db = create({ schema: SCHEMA, components: { tokenizer: createMixedTokenizer() as any } })
    }

    return this.db
  }

  async indexAll(): Promise<void> {
    const newDb = create({ schema: SCHEMA, components: { tokenizer: createMixedTokenizer() as any } })

    const topicsDir = join(this.basePath, 'topics')
    if (existsSync(topicsDir)) {
      for (const file of readdirSync(topicsDir).filter(f => f.endsWith('.md'))) {
        const filePath = join(topicsDir, file)
        const raw = readFileSync(filePath, 'utf-8')
        const { data, content } = parseFrontmatter(raw)

        await insert(newDb, {
          title: (data.title as string) ?? file.replace('.md', ''),
          content: content.trim(),
          path: `topics/${file}`,
          type: 'topic',
          description: (data.description as string) ?? '',
        })
      }
    }

    const convsDir = join(this.basePath, 'conversations')
    if (existsSync(convsDir)) {
      for (const file of readdirSync(convsDir).filter(f => f.endsWith('.md'))) {
        const filePath = join(convsDir, file)
        const raw = readFileSync(filePath, 'utf-8')
        const { data, content } = parseFrontmatter(raw)

        await insert(newDb, {
          title: (data.id as string) ?? file.replace('.md', ''),
          content: content.trim(),
          path: `conversations/${file}`,
          type: 'conversation',
          description: '',
        })
      }
    }

    // Atomically swap the db reference after indexing completes
    this.db = newDb
    this.dbPromise = null
    await this.persist()
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const db = await this.getDb()
    const maxResults = options?.maxResults ?? 5

    // Fetch extra results to account for minScore filtering
    const fetchLimit = options?.minScore ? maxResults * 3 : maxResults
    const result = await search(db, {
      term: query,
      limit: fetchLimit,
      ...(options?.filter?.type ? { where: { type: options.filter.type } } : {}),
    })

    return (result as any).hits
      .filter((hit: any) => !options?.minScore || hit.score >= options.minScore)
      .slice(0, maxResults)
      .map((hit: any) => ({
        path: hit.document.path as string,
        title: hit.document.title as string,
        excerpt: (hit.document.content as string).slice(0, 200),
        score: hit.score,
        type: hit.document.type as 'topic' | 'conversation',
      }))
  }

  private async persist(): Promise<void> {
    if (!this.db) return
    mkdirSync(this.indexPath, { recursive: true })
    const snapshot = save(this.db)
    writeFileSync(join(this.indexPath, 'orama.json'), JSON.stringify(snapshot), 'utf-8')
  }
}
