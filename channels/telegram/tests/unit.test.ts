// Unit characterization tests for the telegram channel's pure helpers.
//
// These import the REAL functions from channel-core (`core/src/routing.ts`) and
// the telegram platform adapter (`telegram-platform.ts`), replacing the old
// attach.logic.test.mjs which mirror-copied the functions and could silently
// drift. They lock observable behavior so the channel-core extraction stays
// behavior-preserving.
//
// Run: node --experimental-strip-types --test tests/unit.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoutingPrefix, sanitizeChannelName, resolveTargetList } from '../../core/src/routing.ts'
import { chunk, extractAttachment, attachmentPlaceholder } from '../telegram-platform.ts'

// NEW CONTRACT (multi-target): parseRoutingPrefix returns `rawTargets: string[]`
// (comma-separated list, names+numbers mixable, deduped) and NO `hadColon` — the
// colon is parsed-and-ignored (no semantic). Single target = a 1-element list.
describe('parseRoutingPrefix', () => {
  test('no prefix → not a routing attempt', () => {
    assert.deepEqual(parseRoutingPrefix('hello world'),
      { matched: false, rawTargets: [], body: 'hello world' })
  })
  test('empty string → not matched', () => {
    assert.equal(parseRoutingPrefix('').matched, false)
  })
  test('single `to main:` → [main], colon ignored, empty body', () => {
    assert.deepEqual(parseRoutingPrefix('to main:'),
      { matched: true, rawTargets: ['main'], body: '' })
  })
  test('single `to ka-dev2: hello` → [ka-dev2] + body', () => {
    assert.deepEqual(parseRoutingPrefix('to ka-dev2: hello'),
      { matched: true, rawTargets: ['ka-dev2'], body: 'hello' })
  })
  test('`to main` (no colon) → [main]', () => {
    assert.deepEqual(parseRoutingPrefix('to main'),
      { matched: true, rawTargets: ['main'], body: '' })
  })
  test('`2main` homophone prefix → [main]', () => {
    assert.deepEqual(parseRoutingPrefix('2main').rawTargets, ['main'])
  })
  test('numeric target `to 1: hi` → [1] + body', () => {
    assert.deepEqual(parseRoutingPrefix('to 1: hi'),
      { matched: true, rawTargets: ['1'], body: 'hi' })
  })
  test('`to all: x` → [all] + body', () => {
    assert.deepEqual(parseRoutingPrefix('to all: x'),
      { matched: true, rawTargets: ['all'], body: 'x' })
  })
  test('case-insensitive prefix + lowercased targets', () => {
    const p = parseRoutingPrefix('TO Main: Hi')
    assert.deepEqual(p.rawTargets, ['main']); assert.equal(p.body, 'Hi')
  })
  test('fullwidth colon ： accepted + ignored', () => {
    assert.equal(parseRoutingPrefix('to main：hi').body, 'hi')
  })

  // ---- multi-target list (comma-separated targets + edges) ----
  test('`to main, ka-dev2` → [main, ka-dev2] (space after comma)', () => {
    assert.deepEqual(parseRoutingPrefix('to main, ka-dev2'),
      { matched: true, rawTargets: ['main', 'ka-dev2'], body: '' })
  })
  test('`to main,ka-dev2` → [main, ka-dev2] (no space)', () => {
    assert.deepEqual(parseRoutingPrefix('to main,ka-dev2').rawTargets, ['main', 'ka-dev2'])
  })
  test('`to main,ka-dev2: hello` → [main, ka-dev2] + body (colon ignored)', () => {
    assert.deepEqual(parseRoutingPrefix('to main,ka-dev2: hello'),
      { matched: true, rawTargets: ['main', 'ka-dev2'], body: 'hello' })
  })
  test('`to 7, 3:` → [7, 3] (numbers)', () => {
    assert.deepEqual(parseRoutingPrefix('to 7, 3:').rawTargets, ['7', '3'])
  })
  test('`to 7, main` → [7, main] (number + name mixed, no colon)', () => {
    assert.deepEqual(parseRoutingPrefix('to 7, main').rawTargets, ['7', 'main'])
  })
  test('list then body: `to a, b, c the message` → [a,b,c] + body', () => {
    assert.deepEqual(parseRoutingPrefix('to a, b, c the message'),
      { matched: true, rawTargets: ['a', 'b', 'c'], body: 'the message' })
  })
  test('duplicate tokens deduped: `to main, main` → [main]', () => {
    assert.deepEqual(parseRoutingPrefix('to main, main').rawTargets, ['main'])
  })
})

// NEW: pure resolver for the multi-target routing semantics —
// found = ONLINE (deliver), offline/unknown = not-found (reported); dedup by
// resolved channel; `all` short-circuits to broadcast. Injecting resolve/isOnline
// keeps it unit-testable without session state.
describe('resolveTargetList', () => {
  // mock: 7→freelancer, 3→main (by number); 9→null (unknown number); names pass through.
  const resolve = (r: string): string | null =>
    r === 'all' ? 'all'
    : r === '7' ? 'freelancer'
    : r === '3' ? 'main'
    : /^\d+$/.test(r) ? null
    : r
  const online = new Set(['main', 'ka-dev2', 'freelancer'])
  const isOnline = (n: string) => online.has(n)
  const R = (raws: string[]) => resolveTargetList(raws, resolve, isOnline)

  test('all online → all delivered, none not-found', () => {
    assert.deepEqual(R(['main', 'ka-dev2']), { deliver: ['main', 'ka-dev2'], notFound: [] })
  })
  test('numbers resolve then deliver', () => {
    assert.deepEqual(R(['7', '3']), { deliver: ['freelancer', 'main'], notFound: [] })
  })
  test('dedup by resolved channel (main + #3==main → one)', () => {
    assert.deepEqual(R(['main', '3']), { deliver: ['main'], notFound: [] })
  })
  test('offline name → not-found (reported by raw token), online delivered', () => {
    assert.deepEqual(R(['main', 'foo']), { deliver: ['main'], notFound: ['foo'] })
  })
  test('unknown number → not-found', () => {
    assert.deepEqual(R(['9']), { deliver: [], notFound: ['9'] })
  })
  test('mixed found + not-found', () => {
    assert.deepEqual(R(['main', '9', 'foo']), { deliver: ['main'], notFound: ['9', 'foo'] })
  })
  test('`all` → broadcast short-circuit', () => {
    assert.deepEqual(R(['all']), { deliver: ['all'], notFound: [] })
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
