// Unit characterization tests for lark-platform.ts pure helpers.
//
// These import the REAL exported helpers (side-effect-free: module state is only
// assigned in initLark(), so importing triggers no config read / no daemon boot).
// They lock the trickiest Lark-specific logic: card/line-break text extraction,
// minute-precision time parsing, and the per-chat message_id dedup ring.
//
// Run: node --experimental-strip-types --test tests/unit.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractText, parseLarkTime, rememberMsgId } from '../lark-platform.ts'

describe('extractText', () => {
  test('plain text → trimmed', () => {
    assert.equal(extractText('  hello world  '), 'hello world')
  })
  test('card XML (<card…>) → dropped (empty)', () => {
    assert.equal(extractText('<card foo="1">stuff</card>'), '')
  })
  test('[卡片] placeholder → dropped (empty)', () => {
    assert.equal(extractText('[卡片] something'), '')
  })
  test('⏎ soft line-break → \\n', () => {
    assert.equal(extractText('line1⏎line2'), 'line1\nline2')
  })
  test('empty / null / non-string → empty', () => {
    assert.equal(extractText(''), '')
    assert.equal(extractText(null), '')
    assert.equal(extractText(undefined), '')
    assert.equal(extractText(123 as any), '')
  })
})

describe('parseLarkTime', () => {
  test('lark minute-precision string → epoch ms', () => {
    const ms = parseLarkTime('2026-05-20 22:51')
    assert.ok(Number.isFinite(ms) && ms > 0)
    // same string parses identically (minute precision: two msgs same minute collide)
    assert.equal(parseLarkTime('2026-05-20 22:51'), ms)
  })
  test('empty → 0', () => {
    assert.equal(parseLarkTime(''), 0)
  })
  test('garbage → 0 (never NaN)', () => {
    assert.equal(parseLarkTime('not-a-time'), 0)
  })
})

describe('rememberMsgId (per-chat dedup ring)', () => {
  test('adds a new id', () => {
    const recent: Record<string, string[]> = {}
    rememberMsgId(recent, 'oc_a', 'm1')
    assert.deepEqual(recent['oc_a'], ['m1'])
  })
  test('does not duplicate an existing id', () => {
    const recent: Record<string, string[]> = { oc_a: ['m1'] }
    rememberMsgId(recent, 'oc_a', 'm1')
    assert.deepEqual(recent['oc_a'], ['m1'])
  })
  test('empty id is ignored', () => {
    const recent: Record<string, string[]> = {}
    rememberMsgId(recent, 'oc_a', '')
    assert.equal(recent['oc_a'], undefined)
  })
  test('per-chat isolation', () => {
    const recent: Record<string, string[]> = {}
    rememberMsgId(recent, 'oc_a', 'm1')
    rememberMsgId(recent, 'oc_b', 'm2')
    assert.deepEqual(recent['oc_a'], ['m1'])
    assert.deepEqual(recent['oc_b'], ['m2'])
  })
  test('rings at 100 (keeps the most recent 100)', () => {
    const recent: Record<string, string[]> = {}
    for (let i = 0; i < 130; i++) rememberMsgId(recent, 'oc_a', `m${i}`)
    assert.equal(recent['oc_a'].length, 100)
    assert.equal(recent['oc_a'][0], 'm30')          // oldest kept
    assert.equal(recent['oc_a'][99], 'm129')        // newest
    assert.ok(!recent['oc_a'].includes('m29'))      // m0..m29 evicted
  })
})
