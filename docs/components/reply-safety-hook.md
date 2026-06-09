# reply-safety-hook — every owner message gets a response (as-built)

A Stop hook that backstops Opus's reply-to-owner failure modes. **Guarantee:** every
message the owner sends from Telegram/Lark ends in either the real answer or an explicit
notice naming the error that ate it — **never silence**. The hook runs NO LLM (pure regex
+ at most one HTTP POST or one `decision:block`), so it cannot loop.

Ground truth: `channels/ops/reply-safety-hook.py`. Tests: `channels/telegram/tests/hook.test.ts`.

## Why it exists

Opus drops owner replies three ways, each leaving the owner staring at silence:

- **LEAK** — the reply tool call is emitted as literal `<invoke>` TEXT (few-shot poisoning)
  instead of a structured tool_use, so it never executes.
- **MALFORMED / PARSE-ERROR** — the tool call is corrupted past parsing (retry also fails);
  the turn produces no deliverable.
- **FORGOT / SILENT** — the model answers in terminal text but never calls the reply tool,
  or ends the turn having said nothing substantive.

The hook is an **after-the-fact** safety net (there is no pre-parse rewrite seam).

## Trigger & gate

- **Stop hook**, registered globally in `~/.claude/settings.json` → every pane runs it.
- No-ops unless `KA_CHANNEL` + `KA_CHANNEL_PORT` are in env (channel panes only).
- **Settle-wait**: a Stop hook can fire before Claude Code flushes the turn's final
  assistant block. If the transcript tail is still a user message, the hook short-polls
  (~1.5 s, 400 ms steps) until an assistant turn lands — fixing the race that silently
  dropped both a leak re-send and a forgot nudge.

## Two mechanisms

| Mechanism | Who acts | What | When |
|---|---|---|---|
| **nudge**  | re-engages the **model** (`decision:block`) | the model re-sends its own reply | the model can plausibly recover |
| **notice** | the **hook** POSTs FIXED text to `/api/send` | a deterministic error message to the owner | the model can't recover — the floor |

The notice is hook-sent because when the model's tool-call emission is broken it can't send
its own error notice (it would corrupt that too). `/api/send` prefixes `[#num-name]` and
routes to the active platform, so the owner sees which pane reported. No text is extracted
for a notice → it can never leak garbage.

## Layer 1 — leak re-send

Scan assistant turns after the last user message. A **well-formed** leaked reply (full
`<invoke …reply>` with `chat_id` + `text`, matched by `LEAK_RE`) is re-sent via `/api/send`,
deduped by `sha256(resend|session|chat_id|text)` against `reply-safety-sent.txt`, and skipped
if a real reply with the same text already went out. A handled leak counts as **answered**.

## Layer 2 — ensure-answered escalation

For the last owner message with no successful reply, classify the failure and escalate. The
nudge budget is **per type** — a poisoned context doesn't recover from extra nudges (the cure
is `/compact`), so don't spin:

| Failure type | Signal | nudge budget | notice |
|---|---|---|---|
| **forgot**  | a clean ≥30-char terminal answer, no reply tool | 2 | generic |
| **silent**  | nothing substantive said | 2 | silent |
| **malformed** | a reply tag as TEXT that `LEAK_RE` can't extract (`REPLY_LEAK_TAG` only) | 1 | "畸形 reply" |
| **parse-error** | `could not be parsed` in any turn, or `isApiErrorMessage` | 1 | "parse error" |

(`malformed` outranks a bare `parse-error`; a well-formed leak is Layer 1's job and counts as
answered.) parse-error text can land in a synthetic **user** message, so it's checked in both
roles.

Escalation per owner message (`message_id`, else a hash of the text):

```
forgot / silent     : nudge#1 → nudge#2 → notice
malformed / parse    : nudge#1 → notice
```

At most **2 `decision:block`s + exactly 1 notice** per owner message → bounded, no loop, and
never silent. If a nudge makes the model recover (a real reply appears), no notice is sent.

## State files (under `$KA_HOME`)

| File | Purpose |
|---|---|
| `reply-safety-sent.txt`     | Layer-1 re-send dedup (sha256 keys) |
| `reply-safety-nudged.txt`   | nudge count per message (`session\|mid\|N`) |
| `reply-safety-notified.txt` | the one notice per message (`session\|mid`) |
| `reply-safety-hook.log`     | one `ENTRY` line per invocation + each re-send / nudge / notice |

## Verification

- **Unit ladder** (`hook.test.ts` + a standalone harness): fabricated transcripts drive the
  real hook against a fake `/api/send`; the ladder is asserted for all four failure types,
  plus answered / leak / cc-ignored / model-recovers-after-nudge. telegram 99/99, lark 33/33.
- **Real-data replay**: 257 real owner messages (the live ka-dev2 + main transcripts) replayed
  through the hook — 235 answered (no false positives), 10 leaks re-sent, and 12 genuine drops
  (6 forgot / 3 silent / 3 parse-error) all caught. The parse-error cases were silent drops
  under the previous hook (which excluded them and had no notice mechanism at all).
