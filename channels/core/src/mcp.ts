// Per-session MCP server factory — platform-independent. Extracted from
// telegram-channel/server.ts (R1a). The two tools:
//   reply           → owner via platform.send (platform-flavored description/instructions)
//   send_to_channel → another CC channel (CC↔CC), pure core (fanout/ccLoopGuard)
// All platform-specific text/IO crosses the injected Platform.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { log } from './log.ts'
import { counters } from './counters.ts'
import { sanitizeChannelName } from './routing.ts'
import {
  channelNumberOf, sessionsOf, allSessions, onlineChannelListStr, byName,
} from './sessions.ts'
import { CHANNEL_FRESH_MS, PROBE_GRACE_MS } from './probe.ts'
import { ccLoopGuard, fanout } from './dispatch.ts'
import type { Platform } from './platform.ts'

export function createMcpServer(channelName: string, platform: Platform): Server {
  const s = new Server(
    { name: `${platform.name}-channel`, version: '0.1.0' },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: platform.instructions(channelName, channelNumberOf(channelName)),
    },
  )

  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: platform.replyToolDescription,
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'chat_id to reply in (from the incoming channel tag).' },
            text: { type: 'string', description: 'Message text. Sent as plain text.' },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'send_to_channel',
        description:
          'Send a message to ANOTHER Claude Code session by its channel name (CC↔CC). ' +
          'The recipient receives it tagged with source="cc" and from_channel=<your channel>; ' +
          'it can reply by calling send_to_channel with target=<that from_channel>. ' +
          `Use target="all" to broadcast to every online channel. This does NOT reach ${platform.name} — use \`reply\` for the owner.`,
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Target channel name (or "all" to broadcast).' },
            text: { type: 'string', description: 'Message text.' },
          },
          required: ['target', 'text'],
        },
      },
      {
        name: 'list_channels',
        description:
          'List every Claude Code session (channel) currently connected to this daemon, with its ' +
          'stable number, name, and LIVE status. The daemon pings each session about every 5s, so ' +
          '`alive` is real-time liveness (an actual recent ping succeeded) — not a guess from logs. ' +
          'Use this to see who is online before send_to_channel or a broadcast. No arguments.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))

  s.setRequestHandler(CallToolRequestSchema, async req => {
    // ── reply → owner via the platform ──────────────────────────────────────
    if (req.params.name === 'reply') {
      const args = (req.params.arguments ?? {}) as { chat_id?: string; text?: string }
      const chatId = args.chat_id ?? ''
      const text = args.text ?? ''
      if (!chatId || !text) {
        return { content: [{ type: 'text', text: 'chat_id and text are required' }], isError: true }
      }
      // Prefix with the channel's STABLE number + name, e.g. **[#7-ka-dev2]** — lets
      // the owner identify the sender and route back by number (`to 7:`).
      const prefixed = `**[#${channelNumberOf(channelName)}-${channelName}]** ${text}`
      // The platform owns the reply-target policy (telegram: fixed owner ignoring
      // the passed id; lark: the passed group iff configured). null → rejected.
      const target = platform.resolveReplyTarget(chatId)
      if (!target) {
        return { content: [{ type: 'text', text: `reply target not allowed: ${chatId}` }], isError: true }
      }
      if (String(chatId) !== target) {
        log(`reply: chat_id=${chatId} → routed to ${target} (ch=${channelName})`)
      }
      const err = await platform.send(target, prefixed)
      if (err) {
        log(`reply failed (ch=${channelName}): ${err}`)
        counters.repliesFailed++
        return { content: [{ type: 'text', text: `send error: ${err}` }], isError: true }
      }
      counters.replies++
      return { content: [{ type: 'text', text: `sent to ${chatId} as [#${channelNumberOf(channelName)}-${channelName}]` }] }
    }

    // ── send_to_channel → another CC channel (CC↔CC), never the platform ──────
    if (req.params.name === 'send_to_channel') {
      const args = (req.params.arguments ?? {}) as { target?: string; text?: string }
      const text = args.text ?? ''
      const rawTarget = args.target ?? ''
      if (!rawTarget || !text) {
        return { content: [{ type: 'text', text: 'target and text are required' }], isError: true }
      }
      const target = String(rawTarget).toLowerCase() === 'all' ? 'all' : sanitizeChannelName(rawTarget)
      // Broadcast EXCLUDES the sender's own channel sessions.
      const targets = target === 'all'
        ? allSessions().filter(sess => sess.name !== channelName)
        : sessionsOf(target)
      if (targets.length === 0) {
        const msg = target === 'all'
          ? `no other channel online to broadcast to. online: ${onlineChannelListStr()}`
          : `channel "${target}" not online. online: ${onlineChannelListStr()}`
        return { content: [{ type: 'text', text: msg }], isError: true }
      }
      counters.ccDispatches++
      log(`cc-dispatch from=${channelName} to=${target} [${targets.length} sess]`)
      ccLoopGuard(channelName, target)
      // from_channel is the CALLER's daemon-assigned channel (closure-bound), NOT
      // self-reported → unspoofable.
      await fanout(targets, text, {
        source: 'cc',
        from_channel: channelName,
        ts: Math.floor(Date.now() / 1000),
      }, target)
      return {
        content: [{ type: 'text', text: `sent to "${target}" [${targets.length} sess] as from_channel=${channelName}` }],
      }
    }

    // ── list_channels → the live roster (number / name / alive) ──────────────
    // Same source of truth as GET /api/status: `alive` = a probe ping succeeded
    // within CHANNEL_FRESH_MS (or the session is still within its creation grace).
    if (req.params.name === 'list_channels') {
      const now = Date.now()
      const rows = Array.from(byName.entries()).map(([name, list]) => ({
        num: channelNumberOf(name),
        name,
        online: list.length > 0,
        alive: list.some(sess =>
          (sess.lastProbeOk > 0 && now - sess.lastProbeOk < CHANNEL_FRESH_MS) ||
          (sess.lastProbeOk === 0 && now - sess.createdAt < PROBE_GRACE_MS)),
      })).sort((a, b) => a.num - b.num)
      const body = rows.length === 0
        ? 'no channels connected'
        : rows.map(r =>
            `#${r.num} ${r.name}${r.name === channelName ? ' (you)' : ''} — ` +
            `${r.alive ? 'alive' : (r.online ? 'online (no recent ping)' : 'offline')}`,
          ).join('\n')
      const header = `${rows.length} channel(s) — liveness from the daemon's ~5s ping probe:`
      return { content: [{ type: 'text', text: `${header}\n${body}` }] }
    }

    return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
  })

  return s
}
