import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Fts5Engine } from './fts5-engine.js'
import { incrementalReindexFts5, reindexFts5 } from './fts5-indexer.js'

describe('FTS5 incremental indexer', () => {
  let kb: string
  let engine: Fts5Engine

  beforeEach(() => {
    kb = mkdtempSync(join(tmpdir(), 'ka-fts5-indexer-'))
    mkdirSync(join(kb, 'topics'), { recursive: true })
    writeFileSync(join(kb, 'topics', 'current.md'), '# Current\n\ncurrent content\n')
    engine = new Fts5Engine(join(kb, '.vectors', 'fts5', 'kb.sqlite'))
    reindexFts5(engine, kb)
  })

  afterEach(() => {
    engine.close()
    rmSync(kb, { recursive: true, force: true })
  })

  it('does not lose a migrated file whose preserved mtime predates the watermark', () => {
    const path = join(kb, 'topics', 'migrated.md')
    writeFileSync(path, '# Migrated\n\nold archive lexicalneedle\n')
    const old = new Date(Math.max(1, engine.status()!.source_mtime_max - 86_400_000))
    utimesSync(path, old, old)

    const result = incrementalReindexFts5(engine, kb)
    expect(result.changedPaths).toContain('topics/migrated.md')
    expect(engine.search('lexicalneedle')[0]?.topic).toBe('migrated')
  })

  it('records a zero-chunk hub as processed', () => {
    const path = join(kb, 'topics', 'hub.md')
    writeFileSync(path, `---\ntitle: hub\n---\n\n<!-- sub-topic-index: managed by ka-split-topic — do NOT edit manually -->\n\n## Sub-Topic Index\n- [[current]]\n`)
    const old = new Date(Math.max(1, engine.status()!.source_mtime_max - 86_400_000))
    utimesSync(path, old, old)

    expect(incrementalReindexFts5(engine, kb).changedPaths).toContain('topics/hub.md')
    expect(engine.indexedPaths()).toContain('topics/hub.md')
    expect(incrementalReindexFts5(engine, kb).changedPaths).toEqual([])
  })

  it('detects an existing file replaced with equal-size content and a preserved old timestamp', () => {
    const path = join(kb, 'topics', 'current.md')
    const old = new Date(1000)
    writeFileSync(path, '# Current\n\nalpha content\n')
    utimesSync(path, old, old)
    incrementalReindexFts5(engine, kb)
    writeFileSync(path, '# Current\n\nbravo content\n')
    utimesSync(path, old, old)
    expect(incrementalReindexFts5(engine, kb).changedPaths).toEqual(['topics/current.md'])
    expect(engine.search('bravo')).toHaveLength(1)
    expect(engine.search('alpha')).toHaveLength(0)
    expect(incrementalReindexFts5(engine, kb).changedPaths).toEqual([])
  })

  it('does not let a future timestamp suppress changes to other files', () => {
    const path = join(kb, 'topics', 'future.md')
    writeFileSync(path, '# Future\n\nfuture content\n')
    const future = new Date(Date.now() + 86400_000)
    utimesSync(path, future, future)
    incrementalReindexFts5(engine, kb)
    writeFileSync(join(kb, 'topics', 'current.md'), '# Current\n\nnewneedle\n')
    expect(incrementalReindexFts5(engine, kb).changedPaths).toEqual(['topics/current.md'])
    expect(engine.search('newneedle')).toHaveLength(1)
  })
})
