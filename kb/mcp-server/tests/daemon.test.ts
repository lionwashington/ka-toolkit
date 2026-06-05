// Integration test for the shared HTTP retrieval daemon: boots the real daemon
// against the sanitized self-made corpus (tests/kb-eval/corpus), connects a real
// MCP client over Streamable HTTP, and exercises the tool surface end-to-end.
// The always-on test proves the HTTP transport + tool surface WITHOUT loading the
// embedding model (kb_list_topics/kb_read_topic are store-backed; kb_search with
// no index returns gracefully). A model-backed variant, gated behind RUN_E5=1,
// proves the shared e5 model is loaded once and hybrid search is served over HTTP.
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
 * committed source (the store writes INDEX.md, the engine writes .vectors/).
 * `prepare(kbDir)` runs after the copy, before the daemon starts (e.g. to build
 * the LanceDB index into the temp KB so the daemon's retriever finds it).
 */
async function withDaemon(
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

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text

describe('kb-retrieval HTTP daemon', () => {
  it('exposes the kb tool surface and serves store-backed tools over HTTP (no model)', async () => {
    await withDaemon(async (client) => {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(tools).toEqual(['kb_list_topics', 'kb_read_topic', 'kb_search', 'kb_status'])

      // kb_list_topics shows frontmatter titles; the corpus's network topic is 网络配置.
      const list = await client.callTool({ name: 'kb_list_topics', arguments: {} })
      expect(textOf(list)).toMatch(/网络配置/)

      // kb_search with no index built yet returns gracefully (proves the HTTP path
      // + retriever wiring without loading the embedding model).
      const search = await client.callTool({
        name: 'kb_search',
        arguments: { query: 'NAT 模式', max_results: 5 },
      })
      expect(textOf(search).length).toBeGreaterThan(0)
    })
  }, 60_000)

  it.runIf(process.env.RUN_E5 === '1')(
    'serves hybrid kb_search over HTTP with one shared e5 model (RUN_E5=1)',
    async () => {
      const { createEmbedder, LanceEngine, reindex, LANCE_DB_SUBDIR } = await import('@ka/core')
      await withDaemon(
        async (client) => {
          const search = await client.callTool({
            name: 'kb_search',
            arguments: { query: '上不了网，连不上路由器', max_results: 5 },
          })
          // Hybrid search should surface the network/router topic for a colloquial query.
          expect(textOf(search)).toMatch(/网络配置|路由器/)
        },
        // Build the LanceDB index into the temp KB so the daemon's retriever
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
