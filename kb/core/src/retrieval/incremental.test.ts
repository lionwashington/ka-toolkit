import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanceEngine } from './lance-engine.js'
import { reindex, incrementalReindex } from './indexer.js'

// Constant-vector fake embedder — FTS (text_seg) does the keyword discrimination here.
const fake = {
  model: 'fake',
  async embedDocuments(texts: string[]) { return texts.map(() => [1, 0, 0]) },
  async embedQuery() { return [1, 0, 0] },
}

function writeTopic(kb: string, name: string, body: string, mtimeMs?: number) {
  const p = join(kb, 'topics', `${name}.md`)
  writeFileSync(p, `---\ntitle: ${name}\n---\n\n## H\n${body}\n`)
  if (mtimeMs) { const d = new Date(mtimeMs); utimesSync(p, d, d) }
}

describe('incremental reindex', () => {
  let kb: string
  let engine: LanceEngine
  beforeEach(async () => {
    kb = mkdtempSync(join(tmpdir(), 'kb-incr-'))
    mkdirSync(join(kb, 'topics'), { recursive: true })
    writeTopic(kb, 'alpha', 'alpha network NAT content')
    writeTopic(kb, 'beta', 'beta dns content')
    engine = new LanceEngine(join(kb, 'db'), fake as any)
    await reindex(engine, kb, fake)
  })
  afterEach(() => rmSync(kb, { recursive: true, force: true }))

  it('adds a new topic incrementally + search finds it + version bumps', async () => {
    const before = engine.status()!
    // future mtime so it's strictly > the index's source_mtime_max
    writeTopic(kb, 'gamma', 'gamma routing zzqueryword', Date.now() + 60_000)
    const r = await incrementalReindex(engine, kb, fake)
    expect(r.changedPaths).toContain('topics/gamma.md')
    expect(engine.status()!.version).toBe(before.version + 1)
    const hits = await engine.search('zzqueryword', 5)
    expect(hits.some((h) => h.topic === 'gamma')).toBe(true)
  })

  it('indexes a never-seen migrated path even when its mtime is below the watermark', async () => {
    const oldMtime = Math.max(1, engine.status()!.source_mtime_max - 86_400_000)
    writeTopic(kb, 'migrated-old', 'restored archive uniquemigratedword', oldMtime)
    const r = await incrementalReindex(engine, kb, fake)
    expect(r.changedPaths).toContain('topics/migrated-old.md')
    expect(await engine.indexedPaths()).toContain('topics/migrated-old.md')
  })

  it('watermarks a valid zero-chunk hub instead of retrying it forever', async () => {
    const path = join(kb, 'topics', 'hub.md')
    writeFileSync(path, `---\ntitle: hub\n---\n\n<!-- sub-topic-index: managed by ka-split-topic — do NOT edit manually -->\n\n## Sub-Topic Index\n- [[alpha]]\n`)
    const old = new Date(Math.max(1, engine.status()!.source_mtime_max - 86_400_000))
    utimesSync(path, old, old)

    const first = await incrementalReindex(engine, kb, fake)
    expect(first.changedPaths).toContain('topics/hub.md')
    expect(first.rowCount).toBe(0)
    expect(await engine.indexedPaths()).toContain('topics/hub.md')

    const second = await incrementalReindex(engine, kb, fake)
    expect(second.changedPaths).toEqual([])
  })

  it('is a no-op (no version bump) when nothing changed', async () => {
    const v = engine.status()!.version
    const r = await incrementalReindex(engine, kb, fake)
    expect(r.rowCount).toBe(0)
    expect(r.changedPaths).toEqual([])
    expect(engine.status()!.version).toBe(v)
  })

  it('re-embeds a changed topic (replaces its rows, no duplicates)', async () => {
    const before = await engine.indexedPaths()
    expect(before).toContain('topics/alpha.md')
    writeTopic(kb, 'alpha', 'alpha CHANGED content newword', Date.now() + 60_000)
    await incrementalReindex(engine, kb, fake)
    const hits = await engine.search('newword', 5)
    expect(hits.some((h) => h.topic === 'alpha')).toBe(true)
    // alpha still present exactly once at topic level (dedupe) — no stale duplicate rows blocking it
    expect((await engine.indexedPaths()).filter((p) => p === 'topics/alpha.md').length).toBe(1)
  })

  it('removes rows for a deleted topic', async () => {
    rmSync(join(kb, 'topics', 'beta.md'))
    const r = await incrementalReindex(engine, kb, fake)
    expect(r.removedPaths).toContain('topics/beta.md')
    expect(await engine.indexedPaths()).not.toContain('topics/beta.md')
  })
})
