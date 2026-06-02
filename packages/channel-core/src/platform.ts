// The platform integration-layer contract. channel-core is platform-independent; each platform
// (telegram, lark) implements Platform to plug in ALL of its I/O, identity, config
// and flavor text. The kernel — sessions, routing, dispatch, MCP server, HTTP, and
// crucially probe (M6 ping liveness) + reconnect (consumer-SSE RE-ADOPT instead of
// 404 on daemon restart / half-open closeStandaloneSSEStream) — is shared and given
// to every platform for free. Probe/reconnect operate on the CC↔daemon MCP connection
// (identical for both platforms), so they are NOT platform methods — LarkPlatform
// inherits re-adopt (auto inbound recovery after daemon restart) for free.
//
// Only what crosses THIS interface differs between telegram and lark.

/** Core hands the platform's inbound loop a bound dispatch (one per owner message). */
export type InboundDispatch = (
  targetName: string,
  content: string,
  metaBase: Record<string, unknown>,
) => Promise<void>

export interface Platform {
  /** Display / log name, e.g. 'telegram' | 'lark'. */
  readonly name: string

  // ── identity ────────────────────────────────────────────────────────────────
  /**
   * Resolve where a `reply` actually goes, given the chat_id a session passed.
   * The reply-target POLICY is platform-specific and security-critical:
   *   - telegram: IGNORE the passed id, always return owner_chat_id — a compromised
   *     CC can't message an arbitrary chat (single-owner DM model).
   *   - lark: multi-group — return the passed group chat_id IFF it's a configured
   *     group, else null (only pre-configured groups are reachable).
   * Returns null → the reply is rejected (caller returns a tool error).
   */
  resolveReplyTarget(passedChatId: string): string | null
  /** Self-filter: is this raw inbound message from the owner? (owner_chat_id / self_open_id) */
  isSelf(rawMessage: any): boolean

  // ── inbound ───────────────────────────────────────────────────────────────--
  /**
   * Start the platform's own message-fetch loop (telegram getUpdates long-poll /
   * lark per-group lark-cli polling). Called once by runChannelDaemon after the
   * HTTP server is listening. For each owner message the platform routes it and
   * calls `dispatch(targetName, content, meta)`. The platform owns its cursor /
   * watermark and attachment handling here.
   */
  startInbound(dispatch: InboundDispatch): void | Promise<void>

  // ── outbound ──────────────────────────────────────────────────────────────--
  /** Deliver `text` to a platform target. null on success, else an error string. */
  send(target: string, text: string): Promise<string | null>

  // ── attachment ──────────────────────────────────────────────────────────────
  /**
   * Download a platform attachment to a local absolute path (consumer CC reads it).
   * Returns '' on any failure (caller degrades to text-only). `ref` is platform-
   * specific (telegram: file_id+name+kind; lark: message/resource id). Used inside
   * the platform's own inbound handling.
   */
  fetchAttachment(ref: any): Promise<string>

  // ── flavor / status ───────────────────────────────────────────────────────--
  /** Per-session MCP `instructions` text (platform-flavored: source tags, etc.). */
  instructions(channelName: string, channelNumber: number): string
  /** `reply` tool description (platform-flavored). */
  readonly replyToolDescription: string
  /** Optional delivery ACK after a successful inbound dispatch (e.g. Telegram typing). */
  ackDelivery?(target: string): void
  /** Platform-specific fields merged into /api/status (offset, poll errors, …). */
  statusFields?(): Record<string, unknown>
}
