import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { KnowledgeStore, KnowledgeRetrieval, loadConfig } from '@ka/core'

export function createMcpServer() {
  const config = loadConfig()
  const store = new KnowledgeStore(config.knowledge_base_path)
  const retrieval = new KnowledgeRetrieval(config.knowledge_base_path)
  store.setRetrieval(retrieval)

  // Get topic names dynamically for kb_search description
  let topicNames: string[] = []
  try {
    store.init()
    topicNames = store.listTopics().map((t) => t.name)
    retrieval.indexAll().catch(() => {})
  } catch {
    // Knowledge base may not be initialized yet
  }

  const topicList = topicNames.length > 0 ? topicNames.join(', ') : '(none yet)'

  const server = new McpServer({
    name: 'knowledge-assistant',
    version: '0.1.0',
  })

  // kb_search: semantic search across knowledge base
  server.tool(
    'kb_search',
    `Semantic search across the knowledge base. Available topics: ${topicList}`,
    {
      query: z.string().describe('Search query'),
      max_results: z.number().optional().describe('Maximum number of results to return (default: 5)'),
    },
    async ({ query, max_results }) => {
      try {
        const results = await retrieval.search(query, {
          maxResults: max_results ?? config.retrieval.max_results,
          minScore: config.retrieval.min_score,
        })

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No results found.' }],
          }
        }

        const text = results
          .map((r, i) => `${i + 1}. **${r.title}** (score: ${r.score.toFixed(2)})\n   Path: ${r.path}\n   ${r.excerpt}`)
          .join('\n\n')

        return {
          content: [{ type: 'text', text }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Search failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  const metricsDir = join(config.knowledge_base_path, '.metrics')
  const metricsFile = join(metricsDir, 'kb-read.jsonl')
  function logRead(topic: string, force: boolean) {
    if (!config.memory.frozen_snapshot) return
    try {
      mkdirSync(metricsDir, { recursive: true })
      appendFileSync(metricsFile, JSON.stringify({ ts: new Date().toISOString(), topic, force }) + '\n')
    } catch {
      // Non-fatal: metrics are an observability aid
    }
  }

  // kb_read_topic: read full topic content
  server.tool(
    'kb_read_topic',
    'Read the full content of a knowledge base topic by name. NOTE: when memory.frozen_snapshot is enabled, topics are loaded once per session at startup and cached in conversation context — do NOT re-call this tool for a topic already loaded in this session unless `force: true` (e.g., you know the topic was updated by a distill run since session start).',
    {
      topic: z.string().describe('The topic name to read'),
      force: z.boolean().optional().default(false).describe('Force re-read even if topic is already loaded in session context'),
    },
    async ({ topic, force }) => {
      logRead(topic, force ?? false)
      try {
        const t = store.readTopic(topic)
        const text = [
          `# ${t.name}`,
          `**Description:** ${t.description}`,
          `**Tags:** ${t.tags.length > 0 ? t.tags.join(', ') : 'none'}`,
          `**Created:** ${t.created}`,
          `**Updated:** ${t.updated}`,
          t.relatedTopics && t.relatedTopics.length > 0
            ? `**Related Topics:** ${t.relatedTopics.join(', ')}`
            : null,
          '',
          t.content,
        ]
          .filter((line) => line !== null)
          .join('\n')

        return {
          content: [{ type: 'text', text }],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read topic "${topic}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // kb_list_topics: list all topics with descriptions
  server.tool(
    'kb_list_topics',
    'List all available topics in the knowledge base with their descriptions.',
    {},
    async () => {
      try {
        const topics = store.listTopics()

        if (topics.length === 0) {
          return {
            content: [{ type: 'text', text: 'No topics found in the knowledge base.' }],
          }
        }

        const text = topics.map((t) => `- **${t.name}**: ${t.description}`).join('\n')

        return {
          content: [{ type: 'text', text: `Knowledge base topics:\n\n${text}` }],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list topics: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // kb_status: knowledge base stats
  server.tool(
    'kb_status',
    'Get statistics and status information about the knowledge base.',
    {},
    async () => {
      try {
        const topics = store.listTopics()

        const lines = [
          `**Knowledge Base Status**`,
          `Path: ${config.knowledge_base_path}`,
          `Topics: ${topics.length}`,
          topics.length > 0 ? `Topic names: ${topics.map((t) => t.name).join(', ')}` : null,
          `Distiller interval: ${config.distiller.interval}`,
          `Max search results: ${config.retrieval.max_results}`,
        ]
          .filter((line) => line !== null)
          .join('\n')

        return {
          content: [{ type: 'text', text: lines }],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  return server
}

async function main() {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('MCP server error:', error)
  process.exit(1)
})
