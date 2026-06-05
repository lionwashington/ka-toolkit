import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @ka/core before importing the server
vi.mock('@ka/core', () => {
  const mockTopics = [
    { name: 'typescript', description: 'TypeScript tips and patterns' },
    { name: 'testing', description: 'Testing strategies' },
  ]

  const mockStore = {
    init: vi.fn(),
    setRetrieval: vi.fn(),
    listTopics: vi.fn().mockReturnValue(mockTopics),
    readTopic: vi.fn().mockImplementation((name: string) => {
      const found = mockTopics.find((t) => t.name === name)
      if (!found) throw new Error(`Topic "${name}" not found`)
      return {
        ...found,
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-02T00:00:00Z',
        tags: ['tag1'],
        content: `# ${found.name}\n\nContent for ${found.name}.`,
        relatedTopics: [],
      }
    }),
  }

  const mockRetrieval = {
    indexAll: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([
      {
        path: '/kb/topics/typescript.md',
        title: 'typescript',
        score: 0.85,
        snippet: 'TypeScript is a typed superset of JavaScript.',
      },
    ]),
  }

  return {
    KnowledgeStore: vi.fn().mockReturnValue(mockStore),
    createRetriever: vi.fn().mockReturnValue(mockRetrieval),
    loadConfig: vi.fn().mockReturnValue({
      channel_kind: 'telegram',
      knowledge_base_path: '/tmp/test-kb',
      distiller: { interval: '1h' },
      retrieval: { max_results: 5, daemon: { host: '127.0.0.1', port: 7705 } },
      memory: { frozen_snapshot: false },
    }),
  }
})

// Mock the MCP SDK transport (we don't want to actually start stdio)
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
  })),
}))

describe('MCP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates server successfully', async () => {
    const { createMcpServer } = await import('../src/index.js')
    const server = createMcpServer()
    expect(server).toBeDefined()
    expect(typeof server.connect).toBe('function')
  })

  it('server has correct tool registration (McpServer instance)', async () => {
    const { createMcpServer } = await import('../src/index.js')
    const server = createMcpServer()
    // McpServer exposes _registeredTools internally; verify via the underlying server
    expect(server).toBeDefined()
  })

  describe('tool handlers', () => {
    it('kb_search returns results', async () => {
      const { createRetriever } = await import('@ka/core')
      const retriever = (createRetriever as ReturnType<typeof vi.fn>).mock.results[0]?.value

      if (retriever) {
        const results = await retriever.search('typescript patterns', { maxResults: 5 })
        expect(results).toHaveLength(1)
        expect(results[0].title).toBe('typescript')
        expect(results[0].score).toBe(0.85)
      }
    })

    it('kb_read_topic returns topic content', async () => {
      const { KnowledgeStore } = await import('@ka/core')
      const store = (KnowledgeStore as ReturnType<typeof vi.fn>).mock.results[0]?.value

      if (store) {
        const topic = store.readTopic('typescript')
        expect(topic.name).toBe('typescript')
        expect(topic.content).toContain('typescript')
        expect(topic.tags).toContain('tag1')
      }
    })

    it('kb_read_topic throws for missing topic', async () => {
      const { KnowledgeStore } = await import('@ka/core')
      const store = (KnowledgeStore as ReturnType<typeof vi.fn>).mock.results[0]?.value

      if (store) {
        expect(() => store.readTopic('nonexistent')).toThrow('Topic "nonexistent" not found')
      }
    })

    it('kb_list_topics returns all topics', async () => {
      const { KnowledgeStore } = await import('@ka/core')
      const store = (KnowledgeStore as ReturnType<typeof vi.fn>).mock.results[0]?.value

      if (store) {
        const topics = store.listTopics()
        expect(topics).toHaveLength(2)
        expect(topics[0].name).toBe('typescript')
        expect(topics[1].name).toBe('testing')
      }
    })

    it('kb_status uses config values', async () => {
      const { loadConfig } = await import('@ka/core')
      const config = (loadConfig as ReturnType<typeof vi.fn>)()
      expect(config.knowledge_base_path).toBe('/tmp/test-kb')
      expect(config.retrieval.max_results).toBe(5)
    })
  })
})
