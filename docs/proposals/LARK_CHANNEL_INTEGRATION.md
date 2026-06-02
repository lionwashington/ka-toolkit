# Proposal A (v2): Unifying the channel core abstraction + telegram/lark dual adapters

> Status: **draft pending review, v2** (2026-06-01, drafted by ka-dev2)
> Supersedes v1's "A1 coexistence" framing — pivoting per the lead's feedback toward "unify the abstraction, only the connection layer differs"
> Related source: `packages/telegram-channel/server.ts` (975 lines, latest), `packages/lark-channel/server.ts` (780 lines, the reference source)

## 0. The lead's hypothesis, conclusion first

> "lc/tc only differ when connecting to telegram/lark, everything else is the same? Can we abstract them all out?"

**After a line-by-line diff: the hypothesis holds ~85%, with hard evidence.** tc's source header comment states that it was ported **line by line** from lark; each section's comments clearly mark `(ported verbatim)`: routing-prefix parser / per-session MCP server / HTTP server / lifecycle hooks are all copied as-is. The differences concentrate in one clearly delineated "platform integration layer"; tc's header comment even lists a mapping table:

```
        lark (lc)                          telegram (tc)
B1 inbound : per-group lark-cli polling   → single Bot.api.getUpdates long-poll
B2 outbound: Lark webhook POST            → Bot.api.sendMessage(owner_chat_id, …)
B3 filter  : sender == self_open_id       → update.message.from.id == owner_chat_id
B4 cursor  : per-chat msg-time watermark  → single getUpdates offset (update_id+1)
```

**But there are two important corrections that must be stated clearly:**

1. **"Everything else is the same" was true at the moment of porting, but no longer** — after the port, the core **evolved one-sidedly** in tc, and lc didn't keep up. tc now has three capabilities that lc lacks (see §2). So it's not "just abstract it"; it's "extract the core using tc as the latest baseline, and let lc catch up on the missing capabilities through this abstraction."
2. **One difference is more than just "the connection"** — the inbound **watermark model** is fundamentally different (see §3.2); it belongs in the adapter, but it's not as shallow as "swap one API call."

## 1. Shared Core vs Platform Layer (verified line by line)

### 1.1 True shared core (identical name and structure on both sides, tc marks ported verbatim)

| Module | Functions / contents |
|---|---|
| routing-prefix parse | `parseRoutingPrefix` (`to <name>:` / `to <number>:` / `to all:` / no prefix → main) |
| Session store | `byName: Map<name,Session[]>` FIFO cap=4 + `sessionsById`; `addSession`/`removeSession`/`sessionsOf`/`allSessions` |
| numbering/routing | `channelNumberOf`/`nameByNumber`/`resolveTargetToName`/`onlineChannelListStr`/`sanitizeChannelName` |
| MCP server factory | `createMcpServer` + ListTools/CallTool skeleton |
| HTTP service | `/api/status`, `/api/shutdown`, `/mcp` routing, **unknown session-id → 404 self-heal** |
| delivery | dispatch → all same-name sessions in parallel + per-delivery timeout; the meta-all-strings invariant |
| state/logging | `loadState`/`saveState`/watermark persistence, `log` |
| lifecycle | lifecycle hooks, boot, singleton |

### 1.2 Platform integration layer (the part that should truly become an adapter)

| Dimension | telegram (tc) | lark (lc) |
|---|---|---|
| **config schema** | single owner: `owner_chat_id` + `bot_token_env` + `poll_timeout` | multi-group: `groups{chatId:{webhook_url,poll_interval}}` + `self_open_id` + `lark_cli_bin` |
| **B1 inbound** | `bot.api.getUpdates` long-poll (`pollLoop`) | per-group `lark-cli im chat-messages-list` polling (`pollGroup`/`fetchChatMessages`/`runLarkCli` spawns bash) |
| **B2 outbound** | `bot.api.sendMessage(owner, text)` (`sendToTelegram`, 4096 chunking) | webhook `POST <url>` (`postToLarkWebhook`, fetch) |
| **B3 self-filter** | `from.id === Number(owner_chat_id)` | `sender.id === self_open_id` + `sender_type==='user'` |
| **B4 watermark** | single global cursor offset = `update_id+1`; `anchorOffsetIfFresh` | **per-group** `last_seen_msg_time` + **message_id-level dedup** (`recent_msg_ids`, because Lark's create_time has minute-level precision; see §3.2) |
| **identity init** | `new Bot(TOKEN)`, `OWNER_ID` | `lark_cli_bin` + app credentials (auth on the lark-cli side) |
| **attachments** | full download (`extractAttachment`/`downloadAttachment`, getFile + 12s timeout) | ✗ none |
| **odds and ends** | typing indicator `sendChatAction`, reply tool description with Telegram context | reply tool description with Lark context |

## 2. tc has, lc lacks — capabilities this unification must backfill

| Capability | tc | lc | Notes |
|---|---|---|---|
| **probe-M6** | ✅ standard MCP `ping` REQUEST + half-open `closeStandaloneSSEStream` keeping the session + `STALE_EVICT_MS=60s` two-stage | ❌ write-only keepalive only + 3-strike `removeSession` + top-2 protection | lc can't catch soft-death/SIGKILL (lc's own §6.1 admits this); tc's measured 24k probes with 0 evicts validates this blind spot |
| **cc2cc** | ✅ `send_to_channel` tool + `from_channel` + `ccLoopGuard` (2s window / 5 times loop prevention) + `fanout` | ❌ only `reply`, no CC↔CC | the lead explicitly wants this ported |
| **attachments** | ✅ photo/document download to disk + placeholder | ❌ | **backfill the lark side this time** (the lead has decided) — see the §3.1 interface + §5 P3 + §6 risks (lark-cli attachment-fetch capability needs verification) |

> Note: lc's inbound routing **does have** a `to all:` broadcast sentinel, but that is "the owner broadcasting to all channels," which is a different thing from cc2cc's `send_to_channel` (a CC proactively sending to another CC). What lc lacks is the latter.

## 3. Abstraction Design

### 3.1 Platform interface

```ts
interface Platform {
  name: 'telegram' | 'lark'
  loadConfig(): NormalizedConfig          // each schema → unified shape + platform-private fields
  isSelf(rawMsg): boolean                 // owner_chat_id | self_open_id
  // inbound: emit a normalized message stream; the cursor/watermark is managed by the adapter, the core only tells it "whether there are consumers"
  startInbound(onMessage: (m: InboundMsg) => Promise<void>, cursor: CursorCtl): void
  // outbound: both reply and dispatch-to-platform go through here
  send(target: string, text: string): Promise<string | null>
  // attachments: both platforms must implement (the lead decided to backfill lark). Download to disk →
  // return the local absolute path; the core puts the path into InboundMsg.attachmentPath, and the CC views it with the Read tool.
  fetchAttachment(ref): Promise<string>
}

type InboundMsg = { chatId: string; sender: string; senderId: string;
                    text: string; mid: string; ts: number; attachmentPath?: string }
// CursorCtl: the core provides hasSessions(); the adapter decides whether to advance the watermark accordingly (the offline-replay semantics are shared)
```

### 3.2 The only point that is "more than just connection": the watermark model

- telegram: monotonic `update_id`, a single global offset is enough.
- lark: `create_time` has **minute-level precision** → multiple messages in the same minute collide → must use `t < lastSeen` (to keep same-minute messages) + **message_id dedup** (each group stores the most recent 100 delivered ids) + **record the id and persist before delivering**.

This logic differs, but it **belongs cleanly to the adapter**: the core only exposes `hasSessions()` (no consumers → don't advance the watermark → offline replay), and the adapter manages its cursor/dedup internally. So it still falls within the Platform interface and doesn't pollute the core.

### 3.3 Package structure

```
packages/
  channel-core/          # new: the single source of truth for the core (extracted from tc, since tc is latest)
    src/core.ts          #   session store / routing / MCP factory / HTTP / dispatch / probe-M6 / cc2cc / state
    src/probe.ts         #   probe-M6 (the ping-request two-stage)
    src/cc2cc.ts         #   send_to_channel + ccLoopGuard + fanout
  telegram-channel/      # slimmed down: only the TelegramPlatform implementation + entrypoint
  lark-channel/          # slimmed down: only the LarkPlatform implementation + entrypoint
```

## 4. Process Model: U1 (decided)

**The lead's call: abstract and share at the source level, keep the two independent at the deployment level → U1.**

- **source sharing**: telegram and lark share the same `channel-core` (one core source, fix a bug in one place).
- **deployment independence**: telegram@9877 and lark@9876 are **two independent processes**, each `import { runChannelDaemon } from 'channel-core'` and pass their own Platform. Each starts/stops on its own, with its own supervision, not affecting the other (a lark outage doesn't reach Telegram, fitting fail-closed).

### cc2cc scope: within the same daemon (decided)
- **cc2cc does not cross platforms / does not cross daemons**. `send_to_channel` only routes **between channels of the same daemon**: telegram channels message each other, lark channels message each other.
- Cross-platform cc2cc between a telegram pane ↔ a lark pane is **explicitly not done** (no cross-daemon bridge added). This is naturally consistent with U1's process isolation — a daemon's online table contains only its own platform's channels.
- Impact: the "all" semantics of `send_to_channel`/`to all:` = all online channels in this daemon, not including the other platform.

> U2 (single process, multiple adapters) is rejected: although it naturally supports cross-platform cc2cc, it has a single point of failure + requires modifying the production telegram process, conflicting with the "deployment independence" requirement.

## 5. Migration Plan: tests first (the process the lead set)

**Core methodology (set by the lead): first build a complete test net around the production tc (unit + e2e + interface/contract, including test cases and test code) → make them all green → then refactor → after the refactor, this same test suite must still be all green.** The test net is the objective proof of "zero behavior change for production telegram."

### 5.0 The current state and one unavoidable prerequisite

tc is currently **nearly untestable**:
- The only test, `attach.logic.test.mjs`, **mirror-copies** the functions to test the copy (the comment admits "if you change server.ts you must manually sync this") — it doesn't test the real code and will drift.
- Root cause: server.ts:959 `app.listen` + `pollLoop()` are at the **top level with no gate**, and the functions aren't exported → **importing starts the daemon**, so no function can be safely referenced in a test.

→ **Phase T0 (testability seam, minimal, behavior-preserving)**: gate the startup logic behind an entrypoint check (`if (isMainModule) { app.listen…; pollLoop() }`) + export the functions under test. When run as the daemon entrypoint, behavior is **completely unchanged**; when imported by a test, it doesn't start. This is the prerequisite for writing any real test, and the only "before tests" micro code change (verify the daemon still starts normally with `--check` + a manual smoke).

### 5.1 Phases

| Phase | Content | Guardrail |
|---|---|---|
| **T0** | tc testability seam (gate startup + export functions), zero behavior change | `--check` + manual smoke: daemon starts as usual, telegram sends/receives as usual |
| **T1** | backfill tc with three layers of characterization tests (vitest, aligned with packages/core), all green. **Replace** the mirror-style attach.logic with a real-import test | see the three-layer checklist in §5.2; assertions target only **observable behavior**, not bound to internal structure (so they survive the refactor) |
| **R0** | extract `packages/channel-core` from tc, change tc to `import core` | **the full T1 suite must still be all green** (the proof of zero behavior change) |
| **R1** | define the Platform interface, gather tc's B1-B4 + attachments into `TelegramPlatform` | T1 still all green |
| **R2** | write `LarkPlatform` (port B1-B4 from lc + self_open_id filter + minute-level dedup + backfill attachments) | the lark side is brand new, doesn't touch tc; verify attachment capability first (§6.7) |
| **R3** | lark automatically gains probe-M6 / cc2cc / 404 self-heal (from the core); write isomorphic characterization tests for lark (reusing the T1 contract/e2e skeleton, swapping in a fake LarkPlatform) | core improvements take effect on both platforms at once |
| **D0** | add `deploy_lark_daemon` to install.sh (runtime/lark-daemon/), workshop pane selects the daemon, lark-ch wrapper, supervision | same invariants as telegram: don't copy secrets, don't touch registration (no --switch) |
| **D1** | end-to-end verification | tc regression (you use it daily) + a real lark group (credentials tested only on your side) |

### 5.2 Three-layer characterization test checklist (T1)

- **Unit (pure functions, real import)**: `parseRoutingPrefix` / `chunk` / `sanitizeChannelName` / `channelNumberOf`·`nameByNumber` / `resolveTargetToName` / `extractAttachment`·`attachmentPlaceholder` / `ccLoopGuard` / time·dedup helpers. ← replaces the mirror-style attach.logic.
- **Interface/contract**: MCP `ListTools` shape (the schema of reply + send_to_channel), `CallTool` behavior (reply→outbound, send_to_channel routing + loop-guard), HTTP `/api/status` JSON shape, **unknown session-id→404 self-heal**, `/api/shutdown`, 🔴 notification meta all-strings.
- **e2e (spawn daemon + real MCP client, external platform via fake injection)**: inbound message → delivered to the right session; probe-M6 half-open → closeStandaloneSSEStream → reconnect; no session → watermark doesn't advance (offline replay); cc2cc fanout + `to all`; FIFO cap=4 eviction.
  - To avoid depending on real Telegram: inject a **fake platform ingress/egress** (a fake inbound source + capture outbound). This also rehearses the Platform abstraction — testability and the refactor goal are naturally aligned: **the degree to which you can cleanly inject a fake is the degree to which the abstraction is done right**.

> Key discipline: T1's assertions are written at the **observable-behavior** layer (routing result / delivery target / API shape / probe state transitions), not bound to internal data structures like `byName`. Otherwise the moment the refactor changes a structure, the tests go red and the safety net fails. This is the prerequisite for "the same test suite still all green after the refactor" to hold.

## 6. Risks and Invariants That Must Be Preserved

1. 🔴 Extracting the core is a **pure refactor**, and **the objective proof of zero behavior change for production telegram = the T1 characterization test net still all green after R0/R1** (you use it daily, it can't regress). Tests precede the refactor; assertions bind only observable behavior (§5.2).
2. 🔴 The real lark config.json (self_open_id / webhook tokens) **never goes into git**; install does not copy secrets.
3. 🔴 meta all-strings — lark's historical culprit was exactly the numeric `channel_number` field.
4. 🔴 **After the probe uses a ping-request, a failure must not directly evict**: it must closeStandaloneSSEStream to keep the session + a 60s grace (otherwise it repeats lark v0.5.2's "request-ping kills the one-way consumer by mistake → doesn't surface"). The old lark invariant "never use a request-style ping" is overturned by M6; after unification both docs must be updated.
5. Only deliver the user's own messages (owner_chat_id / self_open_id) — to prevent prompt injection.
6. Fixed port isolation (9877/9876), singleton via port binding.
7. **lark attachment-fetch capability needs verification**: the existing lark reference source has **no** attachment handling at all. Before backfilling, first confirm whether `lark-cli` can fetch message attachments (image/file resource); if lark-cli doesn't support it, the fallback is for the daemon to call the Lark OpenAPI directly (`im/v1/messages/:id/resources`, requires an app token). This is a P3 prerequisite verification point, not something to discover only when writing code.

## 7. Decision Points

**Decided (the lead has ruled):**
1. ✅ Process model = **U1** (share channel-core at the source, two independent processes at deploy)
2. ✅ cc2cc = **within the same daemon, not cross-platform** (no cross-daemon bridge added)
3. ✅ Attachments = **backfill the lark side** (lark-cli/Lark API fetch, P3 prerequisite verification of fetch capability, see §6.7)
4. ✅ `channel-core` = goes in **`packages/channel-core/`**

**The one final go awaiting your review of the whole proposal:**
5. The process has been re-sequenced per your "tests first" rule (§5): first T0 testability seam + T1 three-layer characterization tests all green, **then** refactor, and after the refactor the same suite must still be all green. After you finish reviewing, just give the go signal — I will **make the T1 test net green and hand it to you first**, and only touch the R0 refactor after you confirm.

## 8. Effort Estimate (U1)

| Phase | Size |
|---|---|
| T0 testability seam | small (but careful, behavior-preserving) |
| T1 three-layer characterization tests + all green | **large** (the safety net, most critical, slow going — determines whether we dare refactor later) |
| R0 extract channel-core + tc import (T1 must stay green) | medium-large |
| R1 Platform interface + TelegramPlatform | medium |
| R2 LarkPlatform (+ attachment verification and backfill) | medium |
| R3 lark auto-gains capabilities + lark characterization tests | medium |
| D0 install/workshop/supervision integration | medium |
| D1 end-to-end (tc regression + real lark group) | medium (real group on your side) |
