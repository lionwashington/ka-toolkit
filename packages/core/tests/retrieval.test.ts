import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KnowledgeRetrieval } from '../src/retrieval/retrieval.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('KnowledgeRetrieval', () => {
  let tempDir: string
  let retrieval: KnowledgeRetrieval

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-retrieval-'))
    mkdirSync(join(tempDir, 'topics'), { recursive: true })
    retrieval = new KnowledgeRetrieval(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('indexes and searches topic content (full-text)', async () => {
    writeFileSync(join(tempDir, 'topics', 'health.md'), `---
title: health
description: exercise and diet
---

## Exercise Habits
Run 3 times a week, 5km each time
`)

    writeFileSync(join(tempDir, 'topics', 'career.md'), `---
title: career
description: career planning
---

## Technical Direction
Focused on backend architecture and distributed systems
`)

    await retrieval.indexAll()

    const results = await retrieval.search('exercise habits run')

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].title).toBe('health')
  })

  it('returns empty results for no match', async () => {
    await retrieval.indexAll()
    const results = await retrieval.search('quantum physics')
    expect(results).toHaveLength(0)
  })
})
