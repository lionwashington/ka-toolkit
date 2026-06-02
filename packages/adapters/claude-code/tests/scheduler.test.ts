import { describe, it, expect, vi } from 'vitest'
import { parseInterval, DistillScheduler } from '../src/scheduler.js'

describe('parseInterval', () => {
  it('parses hours', () => expect(parseInterval('2h')).toBe(7200000))
  it('parses minutes', () => expect(parseInterval('30m')).toBe(1800000))
  it('parses days', () => expect(parseInterval('1d')).toBe(86400000))
})

describe('DistillScheduler', () => {
  it('creates and stops without error', () => {
    const check = vi.fn().mockReturnValue(false)
    const onNeed = vi.fn()
    const scheduler = new DistillScheduler(check, onNeed, '1h')
    scheduler.start()
    scheduler.stop()
    expect(scheduler).toBeDefined()
  })
})
