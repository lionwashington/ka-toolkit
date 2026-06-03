// Routing-prefix parsing + channel-name sanitation — platform-independent.
// Extracted verbatim from telegram-channel/server.ts (which was itself ported
// from lark-channel). Shared by both platforms; no module-state dependency.

// Lenient routing-prefix parser. Accepts:
//   prefix `to` (case-insensitive) OR `2` (homophone), optional whitespace,
//   a COMMA-SEPARATED LIST of target tokens (each a channel name OR number),
//   optional colon `:`/`：` (parsed but with NO semantic), optional whitespace,
//   then the body.
// Examples: `to main` `to main:` `2main` → ['main']; `to main, ka-dev2` /
//   `to main,ka-dev2:` → ['main','ka-dev2']; `to 7, 3:` → ['7','3'];
//   `to 7, main` → ['7','main']; `to a, b, c msg` → ['a','b','c'] + body 'msg'.
// Tokens are lowercased, trimmed, empties dropped, duplicates removed (order kept).
// Returns matched=false when the text is not a routing attempt at all.
export function parseRoutingPrefix(text: string):
  { matched: boolean; rawTargets: string[]; body: string } {
  const m = text.match(/^\s*(?:to|2)\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)\s*[:：]?\s*/i)
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

export function sanitizeChannelName(raw: string | undefined | null): string {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return s || 'main'
}
