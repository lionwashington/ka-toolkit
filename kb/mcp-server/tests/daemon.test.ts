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
import { createRetriever } from '@ka/core/retrieval'
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

async function waitUntilReady(port: number, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`)
      const status = await response.json() as { ready?: boolean; warm_error?: string | null }
      if (status.ready) return
      if (status.warm_error) throw new Error(`daemon warmup failed: ${status.warm_error}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`, { cause: lastError })
}

async function removeTempDir(path: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error: any) {
      lastError = error
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw lastError
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
  mode: 'embedding' | 'fts5' = 'fts5',
  buildFts5 = true,
) {
  const home = mkdtempSync(join(tmpdir(), 'kb-daemon-'))
  const kbDir = join(home, 'kb')
  const stateDir = join(home, 'state')
  cpSync(CORPUS, kbDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  if (prepare) await prepare(kbDir)
  if (mode === 'fts5' && buildFts5) {
    const retriever = createRetriever(kbDir, { retrieval: { mode: 'fts5' } })
    await retriever.reindex?.({ full: true, mode: 'fts5' })
  }
  const port = await freePort()
  const configPath = join(home, 'config.yaml')
  writeFileSync(
    configPath,
    [
      `knowledge_base_path: ${kbDir}`,
      `state_dir: ${stateDir}`,
      `retrieval:`,
      `  mode: ${mode}`,
      `  daemon:`,
      `    host: 127.0.0.1`,
      `    port: ${port}`,
    ].join('\n'),
  )

  let server: Server | undefined
  const client = new Client({ name: 'daemon-test', version: '0.0.0' })
  try {
    server = await runRetrievalDaemon(configPath)
    // runRetrievalDaemon resolves once HTTP is listening, while its initial index
    // build/model warmup continues in the background. Connecting before readiness
    // races that startup (ECONNRESET under the parallel monorepo suite), and tearing
    // the temp dir down while it still writes can produce ENOTEMPTY.
    await waitUntilReady(port)
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)
    await fn(client)
  } finally {
    await client.close().catch(() => {})
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    await removeTempDir(home)
  }
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text

describe('kb-retrieval HTTP daemon', () => {
  it('exposes the kb tool surface and serves store-backed tools over HTTP (no model)', async () => {
    await withDaemon(async (client) => {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(tools).toEqual(['kb_list_topics', 'kb_read_topic', 'kb_search', 'kb_status'])

      const list = await client.callTool({ name: 'kb_list_topics', arguments: {} })
      expect(textOf(list)).toMatch(/Knowledge base topics:/)

      // FTS5 is built and searched without loading the embedding model.
      const search = await client.callTool({
        name: 'kb_search',
        arguments: { query: 'NAT bridge', max_results: 5, mode: 'fts5' },
      })
      expect(textOf(search)).toMatch(/sample-network/)
    })
  }, 60_000)

  it('builds a missing FTS5 index once during daemon startup', async () => {
    await withDaemon(async (client) => {
      const search = await client.callTool({
        name: 'kb_search',
        arguments: { query: 'NAT bridge', max_results: 5 },
      })
      expect(textOf(search)).toMatch(/sample-network/)
    }, undefined, 'fts5', false)
  }, 60_000)

  it.runIf(process.env.RUN_E5 === '1')(
    'serves hybrid kb_search over HTTP with one shared e5 model (RUN_E5=1)',
    async () => {
      const { createEmbedder, LanceEngine, reindex, LANCE_DB_SUBDIR } = await import('@ka/core/retrieval')
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
        'embedding',
      )
    },
    300_000,
  )
})
