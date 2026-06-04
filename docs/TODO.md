# TODO / Backlog

## channel daemon: sendTelegram drops mid-call + swallows send failures

**Bug (reliability).** Two related issues observed 2026-06-04 while a mate
session replied over Telegram:

1. **Silent drop.** Several replies never reached the owner, yet the `reply`
   tool returned success and `ka daemon status` counted `replies N (0 failed)`.
   `sendToTelegram` (`channels/telegram/telegram-platform.ts`) sends plain text
   (no parse_mode), chunked at 4096 — so it is NOT a markdown-parse failure. On
   `bot.api.sendMessage` error it returns an error string, but the MCP `reply`
   path does not propagate that to the caller → the failure is invisible. Likely
   trigger: Telegram rate-limiting on rapid-fire sends, or a transient outbound
   socket error.
2. **Transport drop mid-call.** Once, the MCP call itself failed with
   "transport dropped mid-call; response lost" — the daemon HTTP/MCP connection
   blipped during a send.

**Fix (to design):** make the send path fail-loud — surface `sendToTelegram`'s
error through the `reply` tool result (and increment the `failed` counter);
add a bounded retry/backoff on 429 / transient socket errors; investigate why
the MCP transport drops mid-call (keep-alive / reconnect on the daemon's /mcp
endpoint). Until fixed, callers must not trust "sent" as proof of delivery.

_Reported by the owner 2026-06-04 — record now, fix later._

## KB topic name resolution: display name ≠ callable name

**Bug.** `kb_list_topics` displays each topic's frontmatter `title`, but
`kb_read_topic(name)` resolves the file by **filename stem** (`<name>.md`). When a
topic's `title` differs from its filename (e.g. file `todo.md` with `title: "Todo list"`),
a caller that takes the displayed title and calls `kb_read_topic("Todo list")` gets
`ENOENT` — the displayed name is not the callable name. This is systemic: most topics
use an English kebab-case filename with a longer/localized title.

Root cause is in `kb/core/src/knowledge-store/store.ts`:
- `listTopics()` returns `{ name: data.title ?? stem }` → exposes the **title**.
- `readTopic(name)` opens `topics/${name}.md` → resolves by **filename**.

**Proposed fix (designed, not yet implemented):**
- **R1 (core):** in `readTopic`, try the filename first (fast path / current behavior),
  else fall back to resolving by frontmatter `title` (build a title→stem map, cache it).
  Canonicalize on the filename stem so `frozen_snapshot` / read-metrics key consistently
  (avoid double-loading the same file under two names). Tie-break duplicate titles by
  exact-filename-first, then first title match + a warning (never silent).
- **R2 (mcp-server):** have `kb_list_topics` also expose the callable filename **key**
  (title stays the display name) so callers can use the canonical key.
- **Coupled cleanup:** `updateIndex()` builds wikilinks as `[[topics/${title}|…]]` (uses
  the title) → can emit broken links (`[[topics/<title>]]`) when title ≠ filename.
  Change to `[[topics/${stem}|${title}]]` (stem as link target, title as display).

No knowledge-base **data** changes are needed (R1+R2 are pure code). The vector index
(`.vectors/orama.json`) already keys topic `path` by filename and is rebuilt atomically,
so resolution changes don't double-count.

_Deferred by request 2026-06-03 — fix later._

## distill OOM on very large snapshots — ✅ RESOLVED 2026-06-04

**Fixed** in `kb/ops/distill-bg-worker.sh`: the worker now splits a snapshot
larger than `KA_DISTILL_CHUNK_BYTES` (default 8 MiB) into multiple passes, each a
**fresh `claude -p`** over `[cur_offset, cur_offset+CHUNK]`, so peak memory stays
bounded. It reads the persisted `last_parsed_offset` from the raw frontmatter to
drive the loop and verifies the offset advances each pass (aborts cleanly if a
pass makes no progress, rather than looping forever). A snapshot that fits in one
chunk runs exactly as before (single pass). Covered by test 28-distill-chunk.
The original report is kept below for context.

---

**Bug (robustness).** A `/kb distill` over a very large snapshot is hard-killed
(OOM) before it can run — the headless distiller loads the whole input at once.

- Repro: the main session (`dbe22096`) snapshot was **86 MB / 3871 messages**.
  After `/kb distill` started, the worker was hard-killed; the run log held only
  **111 bytes** (a single `start_iso` line — no error, and it never wrote the
  failure sentinel). `ka distill status` then showed
  `running-but-pid-dead (likely crashed)`.
- Same symptom as the earlier ~43 MB self-transcript crash. Pure
  **input-too-large** → OOM/kill, not a logic error.
- `chdir` is **ruled out** (already fixed — the worker derives `WORKSPACE_CWD`
  from config.yaml, no placeholder).

**Proposed fix (to design, not implemented):** make the distiller process large
snapshots **chunked / streaming**, or segment an over-threshold snapshot into
several distill passes, so it never tries to hold the whole input in memory.
Secondary: when the worker dies without writing a result, still emit the failure
sentinel (so `ka distill status` reports `failed`, not a stuck `running`).

**Priority: low — backlog.** Deferred by the owner 2026-06-04 ("放进 todo,先不急修").
