// Unit characterization tests for telegram-channel/server.ts pure helpers.
//
// These import the REAL functions from server.ts (now side-effect-free thanks to
// the T0 entrypoint guard), replacing the old attach.logic.test.mjs which mirror-
// copied the functions and could silently drift. They lock observable behavior so
// the channel-core extraction (R0+) can be proven behavior-preserving.
//
// Run: node --experimental-strip-types --test tests/unit.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoutingPrefix, sanitizeChannelName } from '../../channel-core/src/routing.ts'
import { chunk, extractAttachment, attachmentPlaceholder } from '../telegram-platform.ts'

describe('parseRoutingPrefix', () => {
  test('no prefix → not a routing attempt', () => {
    assert.deepEqual(parseRoutingPrefix('hello world'),
      { matched: false, hadColon: false, rawTarget: '', body: 'hello world' })
  })
  test('empty string → not matched', () => {
    assert.equal(parseRoutingPrefix('').matched, false)
  })
  test('`to main:` → target main, colon, empty body', () => {
    assert.deepEqual(parseRoutingPrefix('to main:'),
      { matched: true, hadColon: true, rawTarget: 'main', body: '' })
  })
  test('`to ka-dev2: hello` → target+body', () => {
    assert.deepEqual(parseRoutingPrefix('to ka-dev2: hello'),
      { matched: true, hadColon: true, rawTarget: 'ka-dev2', body: 'hello' })
  })
  test('`to main` (no colon) → matched, hadColon=false', () => {
    assert.deepEqual(parseRoutingPrefix('to main'),
      { matched: true, hadColon: false, rawTarget: 'main', body: '' })
  })
  test('`2main` homophone prefix', () => {
    const p = parseRoutingPrefix('2main')
    assert.equal(p.matched, true); assert.equal(p.rawTarget, 'main')
  })
  test('`2 main: body` homophone + colon', () => {
    assert.deepEqual(parseRoutingPrefix('2 main: body'),
      { matched: true, hadColon: true, rawTarget: 'main', body: 'body' })
  })
  test('numeric target `to 1:`', () => {
    assert.deepEqual(parseRoutingPrefix('to 1: hi'),
      { matched: true, hadColon: true, rawTarget: '1', body: 'hi' })
  })
  test('`to all: x` broadcast target', () => {
    assert.deepEqual(parseRoutingPrefix('to all: x'),
      { matched: true, hadColon: true, rawTarget: 'all', body: 'x' })
  })
  test('case-insensitive prefix + lowercased target', () => {
    const p = parseRoutingPrefix('TO Main: Hi')
    assert.equal(p.rawTarget, 'main'); assert.equal(p.body, 'Hi')
  })
  test('fullwidth colon ：accepted', () => {
    const p = parseRoutingPrefix('to main：hi')
    assert.equal(p.hadColon, true); assert.equal(p.body, 'hi')
  })
  test('known quirk: `total recall` parses as routing to "tal"', () => {
    // Documents current lenient behavior — the handleUpdate "no-colon + not online
    // → fall back to main" guard is what makes this harmless in practice.
    const p = parseRoutingPrefix('total recall')
    assert.equal(p.matched, true); assert.equal(p.rawTarget, 'tal'); assert.equal(p.hadColon, false)
  })
})

describe('sanitizeChannelName', () => {
  test('strips disallowed chars', () => assert.equal(sanitizeChannelName('Weex.Repo'), 'weexrepo'))
  test('keeps a-z0-9_-', () => assert.equal(sanitizeChannelName('ka-dev_2'), 'ka-dev_2'))
  test('lowercases', () => assert.equal(sanitizeChannelName('MAIN'), 'main'))
  test('empty → main', () => assert.equal(sanitizeChannelName(''), 'main'))
  test('null → main', () => assert.equal(sanitizeChannelName(null), 'main'))
  test('undefined → main', () => assert.equal(sanitizeChannelName(undefined), 'main'))
  test('all-disallowed → main', () => assert.equal(sanitizeChannelName('!!!@@'), 'main'))
})

describe('chunk', () => {
  test('short text returned as single chunk', () => {
    assert.deepEqual(chunk('hello', 4096, 'newline'), ['hello'])
  })
  test('length mode hard-splits at limit', () => {
    const parts = chunk('aaaabbbbcccc', 4, 'length')
    assert.deepEqual(parts, ['aaaa', 'bbbb', 'cccc'])
  })
  test('newline mode prefers paragraph boundary', () => {
    const text = 'para one here\n\npara two here that is long'
    const parts = chunk(text, 20, 'newline')
    // first cut should land on the blank-line boundary, not mid-word
    assert.equal(parts[0], 'para one here')
    assert.ok(parts.length >= 2)
  })
  test('reassembles to original (length mode, no boundaries lost)', () => {
    const text = 'x'.repeat(100)
    assert.equal(chunk(text, 30, 'length').join(''), text)
  })
})

describe('extractAttachment', () => {
  test('photo → largest (last) size, .jpg', () => {
    assert.deepEqual(
      extractAttachment({ photo: [{ file_id: 's', file_unique_id: 'u1' }, { file_id: 'L', file_unique_id: 'u2' }] }),
      { fileId: 'L', fileName: 'u2.jpg', kind: 'photo' })
  })
  test('document keeps original file_name', () => {
    assert.deepEqual(
      extractAttachment({ document: { file_id: 'd1', file_unique_id: 'ud', file_name: 'report.pdf' } }),
      { fileId: 'd1', fileName: 'report.pdf', kind: 'document' })
  })
  test('voice → .ogg synthesized name', () => {
    assert.deepEqual(extractAttachment({ voice: { file_id: 'v1', file_unique_id: 'uv' } }),
      { fileId: 'v1', fileName: 'uv.ogg', kind: 'voice' })
  })
  test('sticker → .webp', () => {
    assert.deepEqual(extractAttachment({ sticker: { file_id: 's1', file_unique_id: 'us' } }),
      { fileId: 's1', fileName: 'us.webp', kind: 'sticker' })
  })
  test('video recognized', () => {
    assert.equal(extractAttachment({ video: { file_id: 'vv', file_unique_id: 'x' } })?.kind, 'video')
  })
  test('pure text → null', () => assert.equal(extractAttachment({ text: 'hi' }), null))
  test('empty/undefined → null', () => {
    assert.equal(extractAttachment({}), null)
    assert.equal(extractAttachment(undefined), null)
  })
})

describe('attachmentPlaceholder', () => {
  test('photo', () => assert.equal(attachmentPlaceholder('photo', 'x'), '[image]'))
  test('sticker', () => assert.equal(attachmentPlaceholder('sticker', 'x'), '[sticker]'))
  test('voice', () => assert.equal(attachmentPlaceholder('voice', 'x'), '[voice]'))
  test('video', () => assert.equal(attachmentPlaceholder('video', 'x'), '[video]'))
  test('video_note', () => assert.equal(attachmentPlaceholder('video_note', 'x'), '[video]'))
  test('audio', () => assert.equal(attachmentPlaceholder('audio', 'x'), '[audio]'))
  test('document → [attachment: name]', () => assert.equal(attachmentPlaceholder('document', 'a.zip'), '[attachment: a.zip]'))
})
