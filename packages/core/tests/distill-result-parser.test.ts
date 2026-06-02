import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseDistillResult } from '../src/distill/result-parser.js'

function makeClaudeWrapperLine(resultText: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'fake-session',
    result: resultText,
  })
}

function touch(path: string, mtimeMs: number): void {
  const t = mtimeMs / 1000
  utimesSync(path, t, t)
}

function withMemoryDir(root: string): { memory: string; raw: string; conv: string; topics: string } {
  const memory = join(root, 'memory')
  const raw = join(memory, 'raw')
  const conv = join(memory, 'conversations')
  const topics = join(memory, 'topics')
  mkdirSync(raw, { recursive: true })
  mkdirSync(conv, { recursive: true })
  mkdirSync(topics, { recursive: true })
  return { memory, raw, conv, topics }
}

describe('parseDistillResult', () => {
  let tempDir: string
  let logPath: string
  const startIso = '2026-05-26T00:00:00Z'
  const startMs = Date.parse(startIso)

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-distill-parser-'))
    logPath = join(tempDir, 'log.txt')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('tier 0 stats-file: reads the stats JSON the agent wrote, preferred over result/log', () => {
    const { memory } = withMemoryDir(tempDir)
    const statsFilePath = join(tempDir, 'distill-stats.json')
    writeFileSync(statsFilePath, JSON.stringify({
      raw_added: 2, conversations_updated: 1, topics_updated: 3,
      raw_files: ['x.md'], conversations_files: ['2026-05-26.md'], topics_files: ['a.md', 'b.md', 'c.md'],
    }), 'utf-8')
    // A DIFFERENT stats JSON in .result — tier 0 must win over it.
    writeFileSync(logPath, makeClaudeWrapperLine('{"raw_added": 9, "conversations_updated": 9, "topics_updated": 9}') + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso, statsFilePath })

    expect(r.tier).toBe('stats-file')
    expect(r.rawAdded).toBe(2)
    expect(r.conversationsUpdated).toBe(1)
    expect(r.topicsUpdated).toBe(3)
    expect(r.topicsFiles).toHaveLength(3)
  })

  it('tier 0 falls through to result-json when the stats file is absent', () => {
    const { memory } = withMemoryDir(tempDir)
    writeFileSync(logPath, makeClaudeWrapperLine('{"raw_added": 1, "conversations_updated": 0, "topics_updated": 0}') + '\n', 'utf-8')
    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso, statsFilePath: join(tempDir, 'nope.json') })
    expect(r.tier).toBe('result-json')
    expect(r.rawAdded).toBe(1)
  })

  it('tier 0 stats-file: defensive against code fence / prose wrap', () => {
    const { memory } = withMemoryDir(tempDir)
    const statsFilePath = join(tempDir, 'stats.json')
    writeFileSync(statsFilePath, '```json\n{"raw_added": 4, "conversations_updated": 2, "topics_updated": 1}\n```\n', 'utf-8')
    writeFileSync(logPath, makeClaudeWrapperLine('') + '\n', 'utf-8')
    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso, statsFilePath })
    expect(r.tier).toBe('stats-file')
    expect(r.rawAdded).toBe(4)
  })

  it('tier 1 result-json: claude wrapper .result contains final-line stats JSON', () => {
    const { memory } = withMemoryDir(tempDir)
    const resultText = `did some distill work.
processed 5 raw files.
{"raw_added": 1, "conversations_updated": 2, "topics_updated": 3, "raw_files": ["a.md"], "conversations_files": ["2026-05-26.md"], "topics_files": ["finance.md","tools.md","tech.md"]}`
    writeFileSync(logPath, '[distill-worker] start\n' + makeClaudeWrapperLine(resultText) + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('result-json')
    expect(r.rawAdded).toBe(1)
    expect(r.conversationsUpdated).toBe(2)
    expect(r.topicsUpdated).toBe(3)
    expect(r.rawFiles).toEqual(['a.md'])
    expect(r.topicsFiles).toHaveLength(3)
  })

  it('tier 2 log-grep: empty result field, but log contains a bare stats JSON line', () => {
    const { memory } = withMemoryDir(tempDir)
    const log = [
      '[distill-worker] start',
      'doing things...',
      '{"raw_added": 4, "conversations_updated": 1, "topics_updated": 2}',
      makeClaudeWrapperLine(''),
    ].join('\n') + '\n'
    writeFileSync(logPath, log, 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('log-grep')
    expect(r.rawAdded).toBe(4)
    expect(r.conversationsUpdated).toBe(1)
    expect(r.topicsUpdated).toBe(2)
  })

  it('tier 2 log-grep: stats JSON wrapped in markdown code fence', () => {
    const { memory } = withMemoryDir(tempDir)
    const log = [
      '[distill-worker] start',
      '```{"raw_added": 7, "conversations_updated": 0, "topics_updated": 1}```',
      makeClaudeWrapperLine(''),
    ].join('\n') + '\n'
    writeFileSync(logPath, log, 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('log-grep')
    expect(r.rawAdded).toBe(7)
  })

  it('tier 3 mtime-scan: result empty, no JSON in log, but files were touched after start_time', () => {
    const { memory, raw, conv, topics } = withMemoryDir(tempDir)
    writeFileSync(join(raw, '2026-05-26-abc.md'), 'stub raw', 'utf-8')
    writeFileSync(join(conv, '2026-05-26.md'), 'stub daily', 'utf-8')
    writeFileSync(join(topics, 'finance.md'), 'stub topic', 'utf-8')
    writeFileSync(join(topics, 'tech.md'), 'stub topic', 'utf-8')
    const future = startMs + 60_000
    touch(join(raw, '2026-05-26-abc.md'), future)
    touch(join(conv, '2026-05-26.md'), future)
    touch(join(topics, 'finance.md'), future)
    touch(join(topics, 'tech.md'), future)

    writeFileSync(logPath, '[distill-worker] start\n' + makeClaudeWrapperLine('') + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('mtime-scan')
    expect(r.rawAdded).toBe(1)
    expect(r.conversationsUpdated).toBe(1)
    expect(r.topicsUpdated).toBe(2)
    expect(r.rawFiles).toContain('2026-05-26-abc.md')
    expect(r.topicsFiles.sort()).toEqual(['finance.md', 'tech.md'])
    expect(r.notes).toContain('fell back to mtime scan')
  })

  it('tier 3 mtime-scan: skips files older than start_time', () => {
    const { memory, raw } = withMemoryDir(tempDir)
    writeFileSync(join(raw, '2026-05-25-old.md'), 'old raw', 'utf-8')
    writeFileSync(join(raw, '2026-05-26-new.md'), 'new raw', 'utf-8')
    touch(join(raw, '2026-05-25-old.md'), startMs - 86400_000)
    touch(join(raw, '2026-05-26-new.md'), startMs + 60_000)

    writeFileSync(logPath, makeClaudeWrapperLine('') + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('mtime-scan')
    expect(r.rawAdded).toBe(1)
    expect(r.rawFiles).toEqual(['2026-05-26-new.md'])
  })

  it('tier 4 unknown: empty log, no files touched, all stats null', () => {
    const { memory } = withMemoryDir(tempDir)
    writeFileSync(logPath, '[distill-worker] start\n' + makeClaudeWrapperLine('') + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('unknown')
    expect(r.rawAdded).toBeNull()
    expect(r.conversationsUpdated).toBeNull()
    expect(r.topicsUpdated).toBeNull()
    expect(r.notes).toContain('no JSON stats and no files were touched')
  })

  it('phase1Completed=true when a raw file with distilled:true was touched after start_time', () => {
    const { memory, raw } = withMemoryDir(tempDir)
    const rawFile = join(raw, '2026-05-26-abc.md')
    writeFileSync(rawFile, '---\nid: abc\ndistilled: true\n---\n\nbody', 'utf-8')
    touch(rawFile, startMs + 60_000)

    writeFileSync(logPath, makeClaudeWrapperLine(`done.\n{"raw_added": 1, "conversations_updated": 0, "topics_updated": 0}`) + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })
    expect(r.phase1Completed).toBe(true)
  })

  it('phase1Completed=false when raw files were touched but distilled stayed false', () => {
    const { memory, raw } = withMemoryDir(tempDir)
    const rawFile = join(raw, '2026-05-26-abc.md')
    writeFileSync(rawFile, '---\nid: abc\ndistilled: false\n---\n\nbody', 'utf-8')
    touch(rawFile, startMs + 60_000)

    writeFileSync(logPath, makeClaudeWrapperLine('') + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })
    expect(r.phase1Completed).toBe(false)
  })

  it('non-existent log: gracefully falls through to mtime scan', () => {
    const { memory, raw } = withMemoryDir(tempDir)
    writeFileSync(join(raw, '2026-05-26.md'), 'x', 'utf-8')
    touch(join(raw, '2026-05-26.md'), startMs + 60_000)

    const r = parseDistillResult({ logPath: join(tempDir, 'nope.log'), memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('mtime-scan')
    expect(r.rawAdded).toBe(1)
  })

  it('tier 1 result-json: wrapper line without trailing newline, prose appended on same line', () => {
    const { memory } = withMemoryDir(tempDir)
    const wrapper = makeClaudeWrapperLine('summary line.\n{"raw_added": 2, "conversations_updated": 1, "topics_updated": 1}')
    // Worker log: wrapper output then immediately the worker's trailer on the same line (no \n).
    const log = '[distill-worker] start_iso=...\n' + wrapper + '[distill-worker] end_iso=...\n'
    writeFileSync(logPath, log, 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('result-json')
    expect(r.rawAdded).toBe(2)
  })

  it('tier 1 result-json: stats embedded mid-line in result text (prose around JSON)', () => {
    const { memory } = withMemoryDir(tempDir)
    const resultText = 'before {"raw_added": 5, "conversations_updated": 3, "topics_updated": 2} after'
    writeFileSync(logPath, makeClaudeWrapperLine(resultText) + '\n', 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('result-json')
    expect(r.rawAdded).toBe(5)
    expect(r.topicsUpdated).toBe(2)
  })

  it('tier 2 log-grep: stats JSON on a log line that also has prose suffix', () => {
    const { memory } = withMemoryDir(tempDir)
    const log = [
      '[distill-worker] start',
      'progress: {"raw_added": 3, "conversations_updated": 1, "topics_updated": 1} done.',
      makeClaudeWrapperLine(''),
    ].join('\n') + '\n'
    writeFileSync(logPath, log, 'utf-8')

    const r = parseDistillResult({ logPath, memoryDir: memory, startTimeIso: startIso })

    expect(r.tier).toBe('log-grep')
    expect(r.rawAdded).toBe(3)
  })

  it('invalid start_time throws', () => {
    const { memory } = withMemoryDir(tempDir)
    writeFileSync(logPath, '', 'utf-8')
    expect(() => parseDistillResult({ logPath, memoryDir: memory, startTimeIso: 'not-an-iso' })).toThrow()
  })
})
