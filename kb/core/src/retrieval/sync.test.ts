import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanceEngine, type ChunkRow, type EngineEmbedder } from './lance-engine.js'
import { isStale } from './manifest.js'

const fakeEmbedder: EngineEmbedder = { async embedQuery() { return [1, 0, 0] } }

const mkRow = (topic: string, text: string): ChunkRow => ({
  id: `${topic}-0`, path: `topics/${topic}.md`, topic, kind: 'parent', parent: `topics/${topic}.md`,
  title: topic, heading: '', chunk_index: 0, text, text_seg: text, vector: [1, 0, 0], updated: '2026-06-01',
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kb-sync-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sync pipeline (manifest + reader reload)', () => {
  it('🔴 a long-lived reader picks up a writer rebuild WITHOUT restart (kills in-memory staleness)', async () => {
    const dbPath = join(dir, 'db')
    const writer = new LanceEngine(dbPath, fakeEmbedder)
    const reader = new LanceEngine(dbPath, fakeEmbedder) // separate instance = the MCP reader

    await writer.rebuild([mkRow('old', '旧内容')])
    expect((await reader.search('q', 1))[0].topic).toBe('old')

    await writer.rebuild([mkRow('new', '新内容')]) // version bumps to 2
    // The reader had 'old' open; it must detect the version bump and reopen → 'new'.
    expect((await reader.search('q', 1))[0].topic).toBe('new')
  })

  it('bumps the manifest version on each rebuild and records meta', async () => {
    const e = new LanceEngine(join(dir, 'db'), fakeEmbedder)
    await e.rebuild([mkRow('a', 'x')], { sourceMtimeMax: 100, embedModel: 'e5' })
    expect(e.status()!.version).toBe(1)
    await e.rebuild([mkRow('b', 'y')], { sourceMtimeMax: 200, embedModel: 'e5' })
    const m = e.status()!
    expect(m.version).toBe(2)
    expect(m.status).toBe('ok')
    expect(m.source_mtime_max).toBe(200)
    expect(m.embed_model).toBe('e5')
    expect(m.chunk_count).toBe(1)
  })

  it('fails loud: a rebuild error records status:error AND re-throws (no silent swallow)', async () => {
    const e = new LanceEngine(join(dir, 'db'), fakeEmbedder)
    // Empty vectors → LanceDB cannot infer a FixedSizeList → createTable rejects → rebuild must throw.
    const bad: ChunkRow[] = [{ ...mkRow('a', 'x'), vector: [] }]
    await expect(e.rebuild(bad)).rejects.toBeTruthy()
    expect(e.status()!.status).toBe('error')
    expect(e.status()!.error).toBeTruthy()
  })

  it('isStale: topics newer than the build → stale', () => {
    const m = { engine: 'lancedb', version: 1, built_at: '', source_mtime_max: 100, doc_count: 1, chunk_count: 1, embed_model: 'e5', status: 'ok' as const, error: null }
    expect(isStale(m, 150)).toBe(true)
    expect(isStale(m, 100)).toBe(false)
    expect(isStale(null, 0)).toBe(true)
    expect(isStale({ ...m, status: 'error' }, 0)).toBe(true)
  })
})
