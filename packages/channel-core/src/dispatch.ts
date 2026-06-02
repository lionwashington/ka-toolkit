// Notification fan-out + cc-loop guard — platform-independent. Extracted verbatim
// from telegram-channel/server.ts. The platform-specific dispatch wrapper (route-
// miss notice, typing ACK) stays in the daemon and calls fanout() here.
import { log } from './log.ts'
import { counters } from './counters.ts'
import { type Session, sessionsOf, allSessions, onlineChannelListStr } from './sessions.ts'
import type { Platform } from './platform.ts'

// Lightweight cc loop guard: if the same (from→to) channel pair exchanges more
// than CC_LOOP_MAX dispatches within CC_LOOP_WINDOW_MS, log a warning so a
// runaway auto-reply loop is visible after the fact. NO hard block (MVP) — real
// prevention is the consumer instructions ("don't reflexively bounce").
export const CC_LOOP_WINDOW_MS = 2000
export const CC_LOOP_MAX = 5
const ccLoopHits = new Map<string, number[]>()

export function ccLoopGuard(from: string, to: string): void {
  const key = `${from}>${to}`
  const now = Date.now()
  const arr = (ccLoopHits.get(key) ?? []).filter(t => now - t < CC_LOOP_WINDOW_MS)
  arr.push(now)
  ccLoopHits.set(key, arr)
  if (arr.length > CC_LOOP_MAX) {
    log(`WARN cc-loop: ${key} ${arr.length} dispatches in <${CC_LOOP_WINDOW_MS}ms — possible auto-reply loop`)
  }
}

// Dispatch one inbound (owner) message to every same-name session. On route-miss
// (no session for the target) notify the owner via the platform; on success fire
// the platform's optional delivery ACK (e.g. Telegram typing). Shared by every
// platform's inbound loop — the platform-specific I/O crosses the Platform iface.
export async function dispatch(
  platform: Platform,
  targetName: string,
  content: string,
  metaBase: Record<string, unknown>,
): Promise<void> {
  const targets = targetName === 'all' ? allSessions() : sessionsOf(targetName)

  // No session for this target → notify the human in the ORIGINATING chat (skip
  // broadcast-to-none). metaBase.chat_id is where the message came from: telegram's
  // owner DM, or the lark group — correct feedback target for both.
  if (targets.length === 0) {
    if (targetName === 'all') return
    const online = onlineChannelListStr()
    log(`route miss: target=${targetName}, online=${online}`)
    counters.routeMiss++
    const replyTo = String(metaBase.chat_id ?? '')
    if (replyTo) {
      await platform.send(
        replyTo,
        `⚠️ channel "${targetName}" is offline\nOnline channels: ${online}\n(message ack'd; target by name or number, e.g. \`to main:\` / \`to 1:\`)`,
      )
    }
    return
  }

  log(`dispatch → "${targetName}" [${targets.length} sess]: ${content.slice(0, 60)}`)
  counters.dispatches++
  await fanout(targets, content, metaBase, targetName)

  // Lightweight delivery ACK (platform-optional, fire-and-forget): the message
  // reached ≥1 live session. Only on the inbound path (this fn); CC↔CC calls
  // fanout() directly and is intentionally not ACK'd. Accuracy relies on the
  // probe loop reaping dead sessions so we don't ACK a phantom delivery.
  const ackChatId = metaBase.chat_id
  if (ackChatId !== undefined && ackChatId !== null && ackChatId !== '') {
    platform.ackDelivery?.(String(ackChatId))
  }
}

// Deliver one notification to every session in `targets`, in PARALLEL with a
// per-send 5s timeout — a dormant/half-dead session must not block delivery to
// the live consumer-bound session behind it (head-of-line bug). Shared by the
// platform inbound path (dispatch) and the CC↔CC path (send_to_channel) so the
// 🔴 meta-all-String() invariant lives in ONE place (a numeric/object meta field
// makes the dev-channels consumer silently drop the whole notification).
export async function fanout(
  targets: Session[],
  content: string,
  metaBase: Record<string, unknown>,
  targetName: string,
): Promise<void> {
  await Promise.allSettled(targets.map(async sess => {
    try {
      await Promise.race([
        sess.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content,
            meta: Object.fromEntries(
              Object.entries({ ...metaBase, channel_name: sess.name, routed_target: targetName })
                .map(([k, v]) => [k, String(v)]),
            ),
          },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('notify timeout 5s')), 5000)),
      ])
    } catch (e: any) {
      log(`notification failed for ${sess.name} (probe loop will reap): ${e?.message ?? e}`)
    }
  }))
}
