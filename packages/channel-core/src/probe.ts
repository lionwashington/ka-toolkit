// Liveness probe (M6) — platform-independent. Extracted verbatim from
// telegram-channel/server.ts.
//
// Probe = standard MCP `ping` REQUEST (server→client). Every spec-compliant MCP
// client auto-answers pong at the protocol layer, so a LIVE consumer always
// replies in a few ms — no false eviction. A DEAD / SIGKILLed session never
// replies → the request times out → consecutiveFails accrues.
//
// M6 self-heal: at the fail limit we DON'T drop the session — we close just the
// server→client notification stream (closeStandaloneSSEStream) so the client
// reconnects with the SAME session-id and the daemon re-attaches it. Only if it
// stays unreachable for STALE_EVICT_MS (genuinely gone, e.g. SIGKILLed) do we
// finally evict — avoiding both the "404 → client gives up" dead-end and leaked
// zombie sessions.
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { log } from './log.ts'
import { byName, removeSession } from './sessions.ts'

export const PROBE_INTERVAL_MS = 5000
export const PROBE_TIMEOUT_MS = 4000                   // pong reply window (localhost pong is <20ms)
export const CONSECUTIVE_FAIL_LIMIT = 3
export const PROBE_GRACE_MS = PROBE_INTERVAL_MS * 2     // newly-created sessions: grace before evictable
export const CHANNEL_FRESH_MS = PROBE_INTERVAL_MS * 3   // channel_alive window (recent ping ok)
export const STALE_EVICT_MS = 60000                     // half-open grace before real eviction (≫ SSE retry)

export let probeEvictedTotal = 0
export let probesSentTotal = 0
export let probeFailuresTotal = 0
export let probeReconnectTriggeredTotal = 0             // M6: # of closeStandaloneSSEStream self-heals fired

// One probe tick (started via setInterval in the daemon's main()).
export function probeTick(): void {
  for (const [name, list] of Array.from(byName.entries())) {
    if (list.length === 0) continue
    for (const sess of Array.from(list)) {
      const immune = (Date.now() - sess.createdAt) < PROBE_GRACE_MS
      probesSentTotal++
      void sess.server.request({ method: 'ping' }, EmptyResultSchema, { timeout: PROBE_TIMEOUT_MS })
        .then(() => {
          if (sess.staleSince) log(`probe: ${name} ${sess.id.slice(0, 8)} RECONNECTED (ping ok after half-open)`)
          sess.consecutiveFails = 0; sess.lastProbeOk = Date.now(); sess.staleSince = undefined
        })
        .catch((e: any) => {
          sess.consecutiveFails++
          probeFailuresTotal++
          if (immune) {
            if (sess.consecutiveFails === 1 || sess.consecutiveFails % 6 === 0)
              log(`probe: ${name} ${sess.id.slice(0, 8)} ping miss ${sess.consecutiveFails}/${CONSECUTIVE_FAIL_LIMIT} (creation grace): ${e?.message ?? e}`)
            return
          }
          // M6 ① first time we hit the fail limit → declare half-open. Do NOT drop the
          // session; close just the notification stream so the CC reconnects with the
          // same session-id (daemon re-attaches via the existing branch), and keep the
          // session for STALE_EVICT_MS awaiting that reconnect.
          if (sess.consecutiveFails === CONSECUTIVE_FAIL_LIMIT) {
            log(`probe: ${name} ${sess.id.slice(0, 8)} half-open (${sess.consecutiveFails}×); closeStandaloneSSEStream + keep session for reconnect`)
            try { (sess.transport as any).closeStandaloneSSEStream?.() }
            catch (err: any) { log(`  closeStandaloneSSEStream err: ${err?.message ?? err}`) }
            sess.staleSince = Date.now()
            probeReconnectTriggeredTotal++
            return
          }
          // M6 ② reconnect was triggered but pings still fail past the grace window →
          // the CC is genuinely gone (e.g. SIGKILLed). Now finally evict.
          if (sess.staleSince && (Date.now() - sess.staleSince) >= STALE_EVICT_MS) {
            log(`probe: ${name} ${sess.id.slice(0, 8)} still dead ${STALE_EVICT_MS}ms after reconnect-trigger; evicting: ${e?.message ?? e}`)
            removeSession(sess.id)
            probeEvictedTotal++
            return
          }
          if (sess.consecutiveFails % 6 === 0)
            log(`probe: ${name} ${sess.id.slice(0, 8)} still half-open ${sess.consecutiveFails}× (awaiting reconnect): ${e?.message ?? e}`)
        })
    }
  }
}
