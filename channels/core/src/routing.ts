// Routing-prefix parsing + channel-name sanitation — platform-independent.
// Extracted verbatim from telegram-channel/server.ts (which was itself ported
// from lark-channel). Shared by both platforms; no module-state dependency.

// Lenient routing-prefix parser. Accepts:
//   prefix `to` (case-insensitive) OR `2` (homophone), then AT LEAST ONE space,
//   a COMMA-SEPARATED LIST of target tokens (each a channel name OR number),
//   optional colon `:`/`：` (parsed but with NO semantic), optional whitespace,
//   then the body.
// The mandatory space after the prefix is what stops false positives: `2fa`,
//   `2024`, `2nd`, `tomorrow` are NOT routes (prefix glued to the next chars), while
//   `to main` / `2 main` still route. Leading whitespace before the prefix is fine.
// Quote escape: a message that (after leading spaces) STARTS WITH A QUOTE is literal
//   content, never a route — the wrapping quote pair is stripped. So `"to main: x"`
//   delivers `to main: x` to the sticky target instead of routing to main.
// Examples: `to main` `to main:` `2 main` → ['main']; `to main, ka-dev2` /
//   `to main,ka-dev2:` → ['main','ka-dev2']; `to 7, 3:` → ['7','3'];
//   `to 7, main` → ['7','main']; `to a, b, c msg` → ['a','b','c'] + body 'msg'.
// Tokens are lowercased, trimmed, empties dropped, duplicates removed (order kept).
// Returns matched=false when the text is not a routing attempt at all.
const QUOTES = `"'“”‘’`
export function parseRoutingPrefix(text: string):
  { matched: boolean; rawTargets: string[]; body: string } {
  // Quote escape: leading quote → literal content, strip the wrapping quote pair.
  const q = text.match(new RegExp(`^\\s*([${QUOTES}])([\\s\\S]*)$`))
  if (q) {
    let body = q[2]
    const close = body.match(new RegExp(`^([\\s\\S]*?)[${QUOTES}]\\s*$`))
    if (close) body = close[1]
    return { matched: false, rawTargets: [], body }
  }
  // `to`/`2` then a MANDATORY space (the fix for 2fa/2024/tomorrow), then targets.
  const m = text.match(/^\s*(?:to|2)\s+([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)\s*[:：]?\s*/i)
  if (!m) return { matched: false, rawTargets: [], body: text }
  const seen = new Set<string>()
  const rawTargets: string[] = []
  for (const tok of m[1].split(',')) {
    const t = tok.trim().toLowerCase()
    if (t && !seen.has(t)) { seen.add(t); rawTargets.push(t) }
  }
  return { matched: true, rawTargets, body: text.slice(m[0].length) }
}

// Resolve a parsed target list into the set to DELIVER to and the set NOT FOUND,
// per the confirmed semantics: found = the target resolves to an ONLINE channel
// (deliver); offline or unknown name/number = not-found (reported back, by the raw
// token the user typed). Duplicates are deduped by resolved channel name; a `to all`
// short-circuits to a single broadcast sentinel. Pure (resolve/isOnline injected) so
// it is unit-testable without session state; the daemon passes resolveTargetToName +
// an "is this name online" predicate.
export function resolveTargetList(
  rawTargets: string[],
  resolve: (raw: string) => string | null,
  isOnline: (name: string) => boolean,
): { deliver: string[]; notFound: string[] } {
  for (const r of rawTargets) {
    if (resolve(r) === 'all') return { deliver: ['all'], notFound: [] }
  }
  const deliver: string[] = []
  const notFound: string[] = []
  const seen = new Set<string>()
  for (const r of rawTargets) {
    const name = resolve(r)
    if (name && isOnline(name)) {
      if (!seen.has(name)) { seen.add(name); deliver.push(name) }
    } else {
      notFound.push(r)
    }
  }
  return { deliver, notFound }
}

// Sticky-routing decision — platform-independent, shared by EVERY platform's inbound
// path (telegram, lark, …) so the "no prefix → last target" rule lives in ONE place.
// Given a parsed routing prefix and the last single target this conversation was sent
// to, return the target list to dispatch AND the last_target to persist:
//   • explicit prefix  → use its targets; remember it ONLY when it is a SINGLE,
//                        non-`all` target (multi-target and `to all` do NOT stick)
//   • no prefix (bare) → reuse last_target as a 1-element list, or [] when there is
//                        none — an empty list makes core dispatch prompt the owner to
//                        pick a channel (no silent default), and an offline remembered
//                        target falls through to the same "not found" prompt.
// The caller persists the returned lastTarget in its own platform state (telegram: one
// global value; lark: keyed per chat). Pure → unit-testable with no platform state.
export function applyStickyRouting(
  parsed: { matched: boolean; rawTargets: string[]; body: string },
  lastTarget: string | undefined,
): { rawTargets: string[]; lastTarget: string | undefined } {
  if (parsed.matched) {
    const remember = parsed.rawTargets.length === 1 && parsed.rawTargets[0] !== 'all'
    return { rawTargets: parsed.rawTargets, lastTarget: remember ? parsed.rawTargets[0] : lastTarget }
  }
  return { rawTargets: lastTarget ? [lastTarget] : [], lastTarget }
}

export function sanitizeChannelName(raw: string | undefined | null): string {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return s || 'main'
}
