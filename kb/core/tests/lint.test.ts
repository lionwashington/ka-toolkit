import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { lintKb, fixIndex, type LintReport } from '../src/lint/lint.js'

let kb: string

function write(rel: string, body: string): void {
  const abs = join(kb, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body, 'utf-8')
}

function topic(stem: string, fm: Record<string, string>, body = ''): void {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')
  write(`topics/${stem}.md`, `---\n${lines}\n---\n\n${body}\n`)
}

function find(r: LintReport, check: string) {
  return r.findings.filter(f => f.check === check)
}

describe('lintKb', () => {
  beforeEach(() => {
    kb = mkdtempSync(join(tmpdir(), 'ka-lint-'))
    mkdirSync(join(kb, 'topics'), { recursive: true })
    mkdirSync(join(kb, 'conversations'), { recursive: true })
    mkdirSync(join(kb, 'raw'), { recursive: true })
  })
  afterEach(() => rmSync(kb, { recursive: true, force: true }))

  it('clean KB → no findings, exit 0', () => {
    topic('tools', { title: 'Tools', description: 'dev tools' }, 'See [[habits]].')
    topic('habits', { title: 'Habits', description: 'routines' }, 'Back to [[tools]].')
    const r = lintKb(kb)
    expect(r.findings).toEqual([])
    expect(r.exitCode).toBe(0)
    expect(r.scale.topics).toBe(2)
  })

  it('dead wikilink in a topic → error, with nearest-match suggestion', () => {
    topic('tools', { title: 'Tools', description: 'd' }, 'ref [[habits]]')
    // no habits.md
    const r = lintKb(kb)
    const dead = find(r, 'dead-wikilink')
    expect(dead).toHaveLength(1)
    expect(dead[0].severity).toBe('error')
    expect(dead[0].file).toBe('topics/tools.md')
    expect(r.exitCode).toBe(2)
  })

  it('.md suffix in a link still resolves (no false positive)', () => {
    topic('recipes', { title: 'Recipes', description: 'd' }, 'x')
    topic('cooking', { title: 'Cooking', description: 'd' }, 'see [[recipes.md]] and [[cooking]] self')
    const r = lintKb(kb)
    expect(find(r, 'dead-wikilink')).toHaveLength(0)
  })

  it('links to conversations/ and raw/ resolve (resolver spans all three dirs)', () => {
    topic('t', { title: 'T', description: 'd' }, 'from [[conversations/2026-06-01]] and [[raw/abc]]')
    write('conversations/2026-06-01.md', '# log')
    write('raw/abc.md', '---\nid: abc\n---\n\nx')
    const r = lintKb(kb)
    expect(find(r, 'dead-wikilink')).toHaveLength(0)
  })

  it('title-form link resolves against a stem-named file', () => {
    topic('todo', { title: 'Todo List', description: 'd' }, 'x')
    topic('t', { title: 'T', description: 'd' }, 'see [[Todo List]]')
    const r = lintKb(kb)
    expect(find(r, 'dead-wikilink')).toHaveLength(0)
  })

  it('wikilinks inside code spans / fences are not flagged dead (doc examples)', () => {
    topic('hub', { title: 'Hub', description: 'd' }, 'see [[habits]]')
    topic('habits', { title: 'Habits', description: 'd' }, [
      'back to [[hub]].',
      'Use the `[[wikilink]]` format for links.', // inline code — not a real link
      '```',
      'template: → 续 [[<date>-part<N>]]',          // fenced — not a real link
      '```',
    ].join('\n'))
    const r = lintKb(kb)
    expect(find(r, 'dead-wikilink')).toHaveLength(0)
  })

  it('orphan topic → warning (no cross-link from any other topic)', () => {
    topic('linked', { title: 'Linked', description: 'd' }, 'see [[hub]]')
    topic('hub', { title: 'Hub', description: 'd' }, 'see [[linked]]')
    topic('island', { title: 'Island', description: 'd' }, 'nobody links here')
    const r = lintKb(kb)
    const orphans = find(r, 'orphan-topic')
    expect(orphans.map(o => o.file)).toEqual(['topics/island.md'])
  })

  it('related: frontmatter counts as a cross-link (not orphan)', () => {
    topic('a', { title: 'A', description: 'd', related: '[b]' }, 'x')
    topic('b', { title: 'B', description: 'd' }, 'x')
    const r = lintKb(kb)
    // b is referenced via a.related → not orphan; a has no inbound → orphan
    expect(find(r, 'orphan-topic').map(o => o.file)).toEqual(['topics/a.md'])
  })

  it('meta/noise-tagged topics are exempt from the orphan check', () => {
    topic('a', { title: 'A', description: 'd' }, 'x [[b]]')
    topic('b', { title: 'B', description: 'd' }, 'x [[a]]')
    write('topics/noise-spawn-handshake.md', '---\ntitle: noise\ndescription: marker\ntags:\n  - meta\n  - noise\n---\n\nsink')
    const r = lintKb(kb)
    expect(find(r, 'orphan-topic').map(o => o.file)).not.toContain('topics/noise-spawn-handshake.md')
  })

  it('parent: frontmatter counts as an inbound edge (hub not orphan)', () => {
    topic('hub', { title: 'Hub', description: 'd' }, 'index of subs') // no body link to sub
    topic('sub', { title: 'Sub', description: 'd', parent: 'hub.md' }, 'content')
    const r = lintKb(kb)
    // hub is referenced via sub.parent → not orphan. (sub may be orphan, that's fine.)
    expect(find(r, 'orphan-topic').map(o => o.file)).not.toContain('topics/hub.md')
  })

  it('bad frontmatter: name: instead of title: → missing-title warning, not dropped silently', () => {
    topic('gadget', { name: 'Gadget' }, 'body') // name: not title:, no description
    const r = lintKb(kb)
    const fm = find(r, 'bad-frontmatter')
    const titleIssue = fm.find(f => f.message.includes('title'))
    expect(titleIssue).toBeDefined()
    expect(titleIssue!.detail).toContain('name:')
  })

  it('unparseable frontmatter → error (the silently-dropped case)', () => {
    write('topics/broken.md', '---\ntitle: "unterminated\n  bad: [1, 2\n---\n\nbody')
    const r = lintKb(kb)
    const fm = find(r, 'bad-frontmatter').filter(f => f.severity === 'error')
    expect(fm).toHaveLength(1)
    expect(fm[0].message).toMatch(/unparseable|dropped/)
    expect(r.exitCode).toBe(2)
  })

  it('duplicate title across two files → warning', () => {
    topic('a', { title: 'Same', description: 'd' }, 'x [[b]]')
    topic('b', { title: 'Same', description: 'd' }, 'x [[a]]')
    const r = lintKb(kb)
    const dup = find(r, 'bad-frontmatter').filter(f => f.message.includes('duplicate'))
    expect(dup).toHaveLength(1)
  })

  it('raw dangling topic ref → warning; distilled raw with no back-ref → info', () => {
    topic('tools', { title: 'Tools', description: 'd' }, 'x')
    write('raw/r1.md', '---\nid: r1\ndistilled: true\ntopics:\n  - 工具\n---\n\nbody') // 工具 not a topic
    write('raw/r2.md', '---\nid: r2\ndistilled: true\ntopics: []\n---\n\nbody') // no back-ref
    write('raw/r3.md', '---\nid: r3\ndistilled: false\n---\n\nbody') // not distilled → no info
    const r = lintKb(kb)
    expect(find(r, 'raw-dangling-topic')).toHaveLength(1)
    const noRef = find(r, 'raw-no-backref')
    expect(noRef).toHaveLength(1)
    expect(noRef[0].severity).toBe('info')
    expect(noRef[0].file).toBe('raw/r2.md')
  })

  it('raw topics: pointing at a conversation → distinct schema-violation finding', () => {
    write('conversations/2026-06-01.md', '# log')
    write('raw/r.md', '---\nid: r\ndistilled: true\ntopics:\n  - conversations/2026-06-01\n---\n\nbody')
    const r = lintKb(kb)
    expect(find(r, 'raw-dangling-topic')).toHaveLength(0) // not counted as a plain dangling
    const viol = find(r, 'raw-topics-not-a-topic')
    expect(viol).toHaveLength(1)
    expect(viol[0].message).toMatch(/schema violation/)
  })

  it('undistilled raw → warning + stat (scans whole corpus)', () => {
    write('raw/old.md', '---\nid: old\ndistilled: false\n---\n\nbody')
    write('raw/done.md', '---\nid: done\ndistilled: true\ntopics:\n  - a\n---\n\nbody')
    topic('a', { title: 'A', description: 'd' }, 'x [[a]]')
    const r = lintKb(kb)
    const u = find(r, 'raw-undistilled')
    expect(u).toHaveLength(1)
    expect(u[0].file).toBe('raw/old.md')
    expect(u[0].severity).toBe('warning')
    expect(r.stats.rawUndistilled).toBe(1)
    expect(r.stats.rawDistilled).toBe(1)
  })

  it('minimal INDEX: no drift false-alarm for the 60 unlisted topics', () => {
    topic('a', { title: 'A', description: 'd' }, 'x [[b]]')
    topic('b', { title: 'B', description: 'd' }, 'x [[a]]')
    write('INDEX.md', '# Knowledge Base Index\n\nRouting is kb_search-only; topics are not hand-listed.\n')
    const r = lintKb(kb)
    expect(r.indexStyle).toBe('minimal')
    expect(find(r, 'index-drift')).toHaveLength(0)
  })

  it('catalog INDEX: a topic missing from the catalog → drift warning', () => {
    topic('a', { title: 'A', description: 'd' }, 'x [[b]]')
    topic('b', { title: 'B', description: 'd' }, 'x [[a]]')
    write('INDEX.md', '# Index\n\n- [[topics/a|A]] — d\n') // b is missing
    const r = lintKb(kb)
    expect(r.indexStyle).toBe('catalog')
    const drift = find(r, 'index-drift')
    expect(drift).toHaveLength(1)
    expect(drift[0].detail).toBe('b')
  })

  it('stats: reports the full-picture counts', () => {
    topic('a', { title: 'A', description: 'd' }, 'see [[b]] and [[gone]]') // 1 resolved + 1 broken
    topic('b', { title: 'B', description: 'd' }, 'back [[a]]') // 1 resolved
    write('conversations/2026-06-01.md', '# log')
    write('raw/r1.md', '---\nid: r1\ndistilled: true\ntopics:\n  - a\n---\n\nx') // valid back-ref
    write('raw/r2.md', '---\nid: r2\ndistilled: true\ntopics: []\n---\n\nx') // empty
    write('raw/r3.md', '---\nid: r3\ndistilled: true\ntopics:\n  - ghost\n---\n\nx') // dangling
    const r = lintKb(kb)
    expect(r.stats.topics).toBe(2)
    expect(r.stats.conversations).toBe(1)
    expect(r.stats.raw).toBe(3)
    expect(r.stats.wikilinks.total).toBe(3) // [[b]],[[gone]],[[a]]
    expect(r.stats.wikilinks.resolved).toBe(2)
    expect(r.stats.wikilinks.broken).toBe(1)
    expect(r.stats.rawDistilled).toBe(3)
    expect(r.stats.rawWithValidBackref).toBe(1)
    expect(r.stats.rawEmptyBackref).toBe(1)
    expect(r.stats.rawDanglingBackref).toBe(1)
  })

  it('info-only findings do not raise the exit code above 0', () => {
    // two topics cross-linking → no orphan; a distilled raw with no back-ref → info only
    topic('a', { title: 'A', description: 'd' }, 'x [[b]]')
    topic('b', { title: 'B', description: 'd' }, 'x [[a]]')
    write('raw/r.md', '---\nid: r\ndistilled: true\n---\n\nbody') // info: no back-ref
    const r = lintKb(kb)
    expect(r.counts.info).toBeGreaterThan(0)
    expect(r.counts.error).toBe(0)
    expect(r.counts.warning).toBe(0)
    expect(r.exitCode).toBe(0)
  })
})

describe('fixIndex', () => {
  beforeEach(() => {
    kb = mkdtempSync(join(tmpdir(), 'ka-lint-fix-'))
    mkdirSync(join(kb, 'topics'), { recursive: true })
  })
  afterEach(() => rmSync(kb, { recursive: true, force: true }))

  it('refuses to touch a minimal INDEX', () => {
    topic('a', { title: 'A', description: 'd' }, 'x')
    write('INDEX.md', '# Index\n\nkb_search-only.\n')
    const before = readFileSync(join(kb, 'INDEX.md'), 'utf-8')
    const res = fixIndex(kb)
    expect(res.fixed).toBe(false)
    expect(readFileSync(join(kb, 'INDEX.md'), 'utf-8')).toBe(before) // untouched
  })

  it('regenerates a catalog INDEX from disk', () => {
    topic('a', { title: 'A', description: 'desc a' }, 'x')
    topic('b', { title: 'B', description: 'desc b' }, 'x')
    write('INDEX.md', '# Index\n\n- [[topics/a|A]] — desc a\n') // b missing → catalog
    const res = fixIndex(kb)
    expect(res.fixed).toBe(true)
    const idx = readFileSync(join(kb, 'INDEX.md'), 'utf-8')
    expect(idx).toContain('a')
    expect(idx).toContain('b') // now both present
  })
})
