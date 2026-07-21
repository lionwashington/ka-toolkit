// Per-channel MCP session store + stable channel numbering — platform-independent.
// Extracted verbatim from telegram-channel/server.ts (R0). Same data structures
// and FIFO/numbering semantics; the only injected dependencies are the logger
// (core/log) and the channel-number persistence hook (initNumbering), both wired
// by the platform daemon in main().
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { log } from './log.ts'
import { sanitizeChannelName } from './routing.ts'

export type Session = {
  id: string            // mcp-session-id (UUID)
  server: Server
  transport: StreamableHTTPServerTransport
  name: string          // channel name, e.g. "main", "ka"; lowercased
  createdAt: number     // Date.now() ms (display)
  monoTs: bigint        // process.hrtime.bigint() — nanosecond monotonic, unique sort key
  consecutiveFails: number  // consecutive probe failures; evict ≥ CONSECUTIVE_FAIL_LIMIT
  lastProbeOk: number   // ms timestamp of last successful probe (0 = never)
  toolsOnly?: boolean   // callable MCP tools, but never an inbound channel consumer
  staleSince?: number   // M6: ms when half-open detected → closeStandaloneSSEStream fired,
                        // session kept for reconnect; evicted only if still dead after STALE_EVICT_MS
}

// Primary store: per-name FIFO list capped at PER_NAME_FIFO_CAP.
//   - New init pushes to the tail; if length exceeds cap, the oldest is shifted out.
//   - Dispatch iterates the list (in parallel) so the dev-channels consumer — which
//     may be on any of the recent sessions — receives the notification.
//   - "Owner" (for display/numbering) = the newest session (list[length-1]).
export const PER_NAME_FIFO_CAP = 4
export const TOOLS_ONLY_PER_NAME_CAP = 4
export const byName = new Map<string, Session[]>()

// Auxiliary index: incoming HTTP requests carry the mcp-session-id (UUID), not
// the channel name. This map lets us route a request to the right transport.
// Kept strictly in sync with byName (every byName push/shift updates this).
export const sessionsById = new Map<string, Session>()

export function addSession(s: Session): void {
  // Codex runtimes receive inbound messages through the App Server bridge. They
  // still need reply/send_to_channel as MCP tools, but registering that MCP
  // connection in byName would create a second inbound consumer for the same
  // channel. Keep tool-only transports addressable by session id without making
  // them routing targets or probe candidates.
  if (s.toolsOnly) {
    const existing = Array.from(sessionsById.values())
      .filter(candidate => candidate.toolsOnly && candidate.name === s.name && candidate.id !== s.id)
      .sort((a, b) => a.monoTs < b.monoTs ? -1 : a.monoTs > b.monoTs ? 1 : 0)
    while (existing.length >= TOOLS_ONLY_PER_NAME_CAP) {
      const evicted = existing.shift()!
      sessionsById.delete(evicted.id)
      log(`tools-only: ${s.name} evict oldest ${evicted.id.slice(0, 8)} (cap=${TOOLS_ONLY_PER_NAME_CAP})`)
      try { void evicted.transport.close?.() } catch {}
    }
    sessionsById.set(s.id, s)
    log(`tools-only: ${s.name} add ${s.id.slice(0, 8)}`)
    return
  }
  let list = byName.get(s.name)
  if (!list) { list = []; byName.set(s.name, list) }
  list.push(s)
  sessionsById.set(s.id, s)
  while (list.length > PER_NAME_FIFO_CAP) {
    const evicted = list.shift()!
    sessionsById.delete(evicted.id)
    log(`fifo: ${s.name} evict oldest ${evicted.id.slice(0, 8)} (cap=${PER_NAME_FIFO_CAP})`)
    try { void evicted.transport.close?.() } catch {}
  }
  log(`fifo: ${s.name} push ${s.id.slice(0, 8)} (len=${list.length})`)
}

export function removeSession(id: string): void {
  const s = sessionsById.get(id)
  if (!s) return
  sessionsById.delete(id)
  if (s.toolsOnly) {
    log(`tools-only: ${s.name} remove ${id.slice(0, 8)}`)
    return
  }
  const list = byName.get(s.name)
  if (list) {
    const i = list.indexOf(s)
    if (i >= 0) list.splice(i, 1)
    if (list.length === 0) byName.delete(s.name)
  }
  log(`fifo: ${s.name} remove ${id.slice(0, 8)} (len=${byName.get(s.name)?.length ?? 0})`)
}

export function sessionsOf(name: string): Session[] {
  return byName.get(name) ?? []
}

export function allSessions(): Session[] {
  const out: Session[] = []
  for (const list of byName.values()) out.push(...list)
  return out
}

// ── stable channel numbering ────────────────────────────────────────────────
// Assigned in first-seen order, persisted by the platform daemon (offset/cursor
// state lives platform-side; only the name→number map + next counter are core).
// initNumbering wires the initial values + a persist hook (called on each assign).
let _numbers: Record<string, number> = {}
let _next = 1
let _persist: (numbers: Record<string, number>, next: number) => void = () => {}

export function initNumbering(
  numbers: Record<string, number>,
  next: number,
  persist: (numbers: Record<string, number>, next: number) => void,
): void {
  _numbers = numbers ?? {}
  _next = next || 1
  _persist = persist
}

export function channelNumberOf(name: string): number {
  if (_numbers[name] != null) return _numbers[name]
  const n = _next
  _numbers[name] = n
  _next = n + 1
  _persist(_numbers, _next)
  return n
}

export function nameByNumber(num: number): string | null {
  for (const [name, n] of Object.entries(_numbers)) if (n === num) return name
  return null
}

// Resolve a raw routing target (already lowercased) to a channel name.
//   'all'      → 'all' (broadcast sentinel)
//   all-digits → the channel name with that number, or null if unknown number
//   otherwise  → sanitized channel name string (may or may not be online)
export function resolveTargetToName(rawTarget: string): string | null {
  if (rawTarget === 'all') return 'all'
  if (/^\d+$/.test(rawTarget)) return nameByNumber(parseInt(rawTarget, 10))
  return sanitizeChannelName(rawTarget)
}

// Online channels formatted as "name(#num)" for user-facing miss messages.
export function onlineChannelListStr(): string {
  const names = Array.from(byName.keys())
  const items = names
    .map(n => ({ n, num: channelNumberOf(n) }))
    .sort((a, b) => a.num - b.num)
    .map(x => `${x.n}(#${x.num})`)
  return items.length ? items.join(', ') : '(no active channel)'
}
