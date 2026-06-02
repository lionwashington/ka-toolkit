// Routing-prefix parsing + channel-name sanitation — platform-independent.
// Extracted verbatim from telegram-channel/server.ts (which was itself ported
// from lark-channel). Shared by both platforms; no module-state dependency.

// Lenient routing-prefix parser. Accepts:
//   prefix `to` (case-insensitive) OR `2` (homophone), optional whitespace,
//   a target token (channel name OR channel number), optional whitespace,
//   optional colon `:`/`：`, optional whitespace, then the body.
// Examples that all parse to target="main": `to main:` `to main` `2main`
//   `2 main` `2 main:` `2 main :` `2  main`. Numeric targets: `to 1:` `to2:`
//   `to 3` `2 1:` → target="1"/"2"/"3" (resolved to a channel by number later).
// Returns matched=false when the text is not a routing attempt at all.
export function parseRoutingPrefix(text: string):
  { matched: boolean; hadColon: boolean; rawTarget: string; body: string } {
  const m = text.match(/^\s*(?:to|2)\s*([A-Za-z0-9_-]+)\s*([:：])?\s*/i)
  if (!m) return { matched: false, hadColon: false, rawTarget: '', body: text }
  return {
    matched: true,
    hadColon: !!m[2],
    rawTarget: m[1].toLowerCase(),
    body: text.slice(m[0].length),
  }
}

export function sanitizeChannelName(raw: string | undefined | null): string {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return s || 'main'
}
