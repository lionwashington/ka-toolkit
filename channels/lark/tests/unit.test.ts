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
import { extractText, parseLarkTime, rememberMsgId, extractLarkAttachment, attachmentPlaceholder } from '../lark-platform.ts'

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

// lark-cli +chat-messages-list renders media content as a tagged string with the
// resource key embedded, e.g. "[Image: img_xxx]" / "[File: file_xxx name]" (NOT JSON).
describe('extractLarkAttachment', () => {
  test('image msg → img_ key pulled from rendered content', () => {
    const att = extractLarkAttachment({ msg_type: 'image', message_id: 'm1', content: '[Image: img_v2_abc-DEF_123]' })
    assert.deepEqual(att, { messageId: 'm1', resType: 'image', key: 'img_v2_abc-DEF_123', kind: 'image' })
  })
  test('file msg → file_ key pulled, resType=file, kind=file', () => {
    const att = extractLarkAttachment({ msg_type: 'file', message_id: 'm2', content: '[File: file_v3_xyz report.pdf]' })
    assert.deepEqual(att, { messageId: 'm2', resType: 'file', key: 'file_v3_xyz', kind: 'file' })
  })
  test('audio/media msgs → file resType but keep their own kind', () => {
    assert.equal(extractLarkAttachment({ msg_type: 'audio', message_id: 'm3', content: '[Audio: file_aud1]' })!.kind, 'audio')
    assert.equal(extractLarkAttachment({ msg_type: 'media', message_id: 'm4', content: '[Video: file_vid1]' })!.kind, 'media')
    assert.equal(extractLarkAttachment({ msg_type: 'media', message_id: 'm4', content: '[Video: file_vid1]' })!.resType, 'file')
  })
  test('text / card / no-key → null (no downloadable resource)', () => {
    assert.equal(extractLarkAttachment({ msg_type: 'text', message_id: 'm5', content: 'hello' }), null)
    assert.equal(extractLarkAttachment({ msg_type: 'image', message_id: 'm6', content: 'no key here' }), null)
    assert.equal(extractLarkAttachment({}), null)
    assert.equal(extractLarkAttachment(null), null)
  })
})

describe('attachmentPlaceholder', () => {
  test('kind → human-readable stand-in (English, matches telegram)', () => {
    assert.equal(attachmentPlaceholder('image'), '[image]')
    assert.equal(attachmentPlaceholder('audio'), '[audio]')
    assert.equal(attachmentPlaceholder('media'), '[video]')   // lark "media" = video
    assert.equal(attachmentPlaceholder('file'), '[file]')
    assert.equal(attachmentPlaceholder('whatever'), '[file]') // default
  })
})
