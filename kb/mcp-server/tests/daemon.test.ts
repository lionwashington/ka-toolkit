// Integration test for the shared HTTP retrieval daemon: boots the real daemon
// against the sanitized self-made corpus (tests/kb-eval/corpus), connects a real
// MCP client over Streamable HTTP, and exercises the tool surface end-to-end.
// The orama path runs always (no model). A lancedb variant, gated behind RUN_E5=1,
// proves the shared embedding model is loaded once and served over HTTP.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runRetrievalDaemon } from '../src/daemon.js'

const REPO = join(import.meta.dirname, '..', '..', '..') // kb/mcp-server/tests → repo root
const CORPUS = join(REPO, 'tests/kb-eval/corpus')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Boot the daemon against a FRESH COPY of the corpus in a temp dir — never the
 * committed source (the orama store writes INDEX.md and lancedb writes .vectors/).
 * `prepare(kbDir)` runs after the copy, before the daemon starts (e.g. to build
 * the lancedb index into the temp KB so the daemon's LanceRetriever finds it).
 */
async function withDaemon(
  engine: 'orama' | 'lancedb',
  fn: (client: Client) => Promise<void>,
  prepare?: (kbDir: string) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), 'kb-daemon-'))
  const kbDir = join(home, 'kb')
  const stateDir = join(home, 'state')
  cpSync(CORPUS, kbDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  if (prepare) await prepare(kbDir)
  const port = await freePort()
  const configPath = join(home, 'config.yaml')
  writeFileSync(
    configPath,
    [
      `knowledge_base_path: ${kbDir}`,
      `state_dir: ${stateDir}`,
      `retrieval:`,
      `  engine: ${engine}`,
      `  daemon:`,
      `    host: 127.0.0.1`,
      `    port: ${port}`,
    ].join('\n'),
  )

  let server: Server | undefined
  const client = new Client({ name: 'daemon-test', version: '0.0.0' })
  try {
    server = await runRetrievalDaemon(configPath)
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)
    await fn(client)
  } finally {
    await client.close().catch(() => {})
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    rmSync(home, { recursive: true, force: true })
  }
}

describe('kb-retrieval HTTP daemon', () => {
  it('exposes the kb tool surface and serves kb_list_topics / kb_search over HTTP (orama)', async () => {
    await withDaemon('orama', async (client) => {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(tools).toEqual(['kb_list_topics', 'kb_read_topic', 'kb_search', 'kb_status'])

      const list = await client.callTool({ name: 'kb_list_topics', arguments: {} })
      const listText = (list.content as Array<{ type: string; text: string }>)[0].text
      // kb_list_topics shows frontmatter titles; the corpus's network topic is 网络配置.
      expect(listText).toMatch(/网络配置/)

      const search = await client.callTool({
        name: 'kb_search',
        arguments: { query: 'NAT 模式', max_results: 5 },
      })
      const searchText = (search.content as Array<{ type: string; text: string }>)[0].text
      // Orama BM25 should surface the network topic for a network query.
      expect(searchText.length).toBeGreaterThan(0)
    })
  }, 60_000)

  it.runIf(process.env.RUN_E5 === '1')(
    'serves hybrid kb_search over HTTP with one shared e5 model (lancedb, RUN_E5=1)',
    async () => {
      const { createEmbedder, LanceEngine, reindex, LANCE_DB_SUBDIR } = await import('@ka/core')
      await withDaemon(
        'lancedb',
        async (client) => {
          const search = await client.callTool({
            name: 'kb_search',
            arguments: { query: '上不了网，连不上路由器', max_results: 5 },
          })
          const text = (search.content as Array<{ type: string; text: string }>)[0].text
          // Hybrid search should surface the network/router topic for a colloquial query.
          expect(text).toMatch(/网络配置|路由器/)
        },
        // Build the lancedb index into the temp KB so the daemon's LanceRetriever
        // (which looks under kbDir/.vectors/lancedb) finds it. One shared embedder.
        async (kbDir) => {
          const emb = createEmbedder()
          const engine = new LanceEngine(join(kbDir, LANCE_DB_SUBDIR), emb)
          await reindex(engine, kbDir, emb)
        },
      )
    },
    300_000,
  )
})
