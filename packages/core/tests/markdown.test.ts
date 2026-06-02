import { describe, it, expect } from 'vitest'
import { parseFrontmatter, serializeWithFrontmatter } from '../src/knowledge-store/markdown.js'

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter and body', () => {
    const content = `---
title: health
created: 2026-04-07
tags: [health, exercise]
---

## Exercise Habits
Run 3 times a week`

    const result = parseFrontmatter(content)

    expect(result.data.title).toBe('health')
    expect(result.data.tags).toEqual(['health', 'exercise'])
    expect(result.content).toContain('## Exercise Habits')
    expect(result.content).toContain('Run 3 times a week')
  })

  it('handles content without frontmatter', () => {
    const content = '# Just a heading\n\nSome text'
    const result = parseFrontmatter(content)

    expect(result.data).toEqual({})
    expect(result.content).toContain('# Just a heading')
  })
})

describe('serializeWithFrontmatter', () => {
  it('serializes data and content to Markdown with frontmatter', () => {
    const data = { title: 'health', created: '2026-04-07', tags: ['health', 'exercise'] }
    const body = '## Exercise Habits\nRun 3 times a week'

    const result = serializeWithFrontmatter(data, body)

    expect(result).toContain('---')
    expect(result).toContain('title: health')
    expect(result).toContain('## Exercise Habits')
  })

  it('roundtrips correctly', () => {
    const data = { title: 'Test', count: 42 }
    const body = 'Hello world'

    const serialized = serializeWithFrontmatter(data, body)
    const parsed = parseFrontmatter(serialized)

    expect(parsed.data.title).toBe('Test')
    expect(parsed.data.count).toBe(42)
    expect(parsed.content.trim()).toBe('Hello world')
  })
})
