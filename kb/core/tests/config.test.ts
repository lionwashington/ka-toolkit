import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig, isCaptureChannelAllowed, injectChannels, type KaConfig } from '../src/config.js'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('loadConfig', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ka-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  it('loads config from YAML file', () => {
    const configPath = join(tempDir, 'config.yaml')
    writeFileSync(configPath, `
channel_kind: lark
knowledge_base_path: /tmp/my-kb
distiller:
  interval: "1h"
  runtime: codex
retrieval:
  mode: fts5
  max_results: 10
`)

    const config = loadConfig(configPath)

    expect(config.knowledge_base_path).toBe('/tmp/my-kb')
    expect(config.channel_kind).toBe('lark')
    expect(config.distiller.interval).toBe('1h')
    expect(config.distiller.runtime).toBe('codex')
    expect(config.state_dir).toBeDefined()
    expect(config.retrieval.max_results).toBe(10)
    expect(config.retrieval.mode).toBe('fts5')
  })

  it('returns defaults when the explicit config file is missing', () => {
    const config = loadConfig(join(tempDir, 'missing.yaml'))

    expect(config.knowledge_base_path).toBeDefined()
    expect(config.workspace_path).toBeDefined()
    expect(config.distiller.interval).toBeDefined()
    expect(config.distiller.runtime).toBe('cc')
    expect(config.channel_kind).toBe('telegram')
    expect(config.retrieval.mode).toBe('fts5')
  })

  it('rejects an unknown distill runtime', () => {
    const configPath = join(tempDir, 'config.yaml')
    writeFileSync(configPath, `distiller:\n  runtime: unknown\n`)
    expect(() => loadConfig(configPath)).toThrow()
  })

  it('expands ~ in knowledge_base_path', () => {
    const configPath = join(tempDir, 'config.yaml')
    writeFileSync(configPath, `knowledge_base_path: ~/my-kb`)

    const config = loadConfig(configPath)

    expect(config.knowledge_base_path).not.toContain('~')
    expect(config.knowledge_base_path).toContain('my-kb')
  })

  it('fail-closed: channels default to empty (do nothing) when not configured', () => {
    // Use an isolated config WITHOUT a channels key — must not read the real
    // ~/.knowledge-assistant/config.yaml (which does configure channels).
    const configPath = join(tempDir, 'config.yaml')
    writeFileSync(configPath, `knowledge_base_path: /tmp/kb\n`)
    const c = loadConfig(configPath)
    expect(c.channels.capture).toEqual([])
    expect(c.channels.inject).toEqual([])
  })

  it('reads explicit channels.capture / channels.inject lists', () => {
    const configPath = join(tempDir, 'config.yaml')
    writeFileSync(configPath, `channels:\n  capture:\n    - main\n    - ka-dev2\n  inject:\n    - main\n`)
    const c = loadConfig(configPath)
    expect(c.channels.capture).toEqual(['main', 'ka-dev2'])
    expect(c.channels.inject).toEqual(['main'])
  })

  it('fail-closed: a wrong-typed channels list falls back to [] and never throws', () => {
    const configPath = join(tempDir, 'config.yaml')
    writeFileSync(configPath, `channels:\n  capture: not-a-list\n  inject: 123\n`)
    expect(() => loadConfig(configPath)).not.toThrow()
    const c = loadConfig(configPath)
    expect(c.channels.capture).toEqual([])
    expect(c.channels.inject).toEqual([])
  })
})

describe('isCaptureChannelAllowed (fail-closed)', () => {
  const cfg = (capture: unknown): any => ({ channels: { capture } })

  it('captures a channel on the whitelist', () => {
    expect(isCaptureChannelAllowed('main', cfg(['main']))).toBe(true)
  })

  it('skips a channel not on the whitelist', () => {
    expect(isCaptureChannelAllowed('ka-dev2', cfg(['main']))).toBe(false)
  })

  it('skips an undefined channel (CC outside the workshop)', () => {
    expect(isCaptureChannelAllowed(undefined, cfg(['main']))).toBe(false)
  })

  it('fail-closed: empty whitelist captures NOTHING', () => {
    expect(isCaptureChannelAllowed('main', cfg([]))).toBe(false)
    expect(isCaptureChannelAllowed(undefined, cfg([]))).toBe(false)
  })

  it('fail-closed: missing/malformed channels captures NOTHING and never throws', () => {
    expect(isCaptureChannelAllowed('main', cfg(undefined))).toBe(false)
    expect(isCaptureChannelAllowed('main', cfg('main' as any))).toBe(false)
    expect(isCaptureChannelAllowed('main', {} as any)).toBe(false)
    expect(() => isCaptureChannelAllowed('x', null as any)).not.toThrow()
  })
})

describe('injectChannels (fail-closed)', () => {
  const cfg = (inject: unknown): any => ({ channels: { inject } })

  it('returns the explicit inject list', () => {
    expect(injectChannels(cfg(['main', 'ka-dev2']))).toEqual(['main', 'ka-dev2'])
  })

  it('fail-closed: empty/missing/malformed → [] and never throws', () => {
    expect(injectChannels(cfg([]))).toEqual([])
    expect(injectChannels(cfg(undefined))).toEqual([])
    expect(injectChannels(cfg('main' as any))).toEqual([])
    expect(injectChannels({} as any)).toEqual([])
    expect(() => injectChannels(null as any)).not.toThrow()
  })

  it('drops non-string / empty entries', () => {
    expect(injectChannels(cfg(['main', '', 42, null, 'x']))).toEqual(['main', 'x'])
  })
})
