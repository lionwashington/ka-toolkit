# TODO / Backlog

_No open items._

## Recently resolved

- **channel daemon: `sendTelegram` silent drops / swallowed send failures** (reported
  2026-06-04). Fixed: `sendToTelegram` (`channels/telegram/telegram-platform.ts`) now
  retries on 429 (honoring `retry_after`), 5xx, and transient socket blips, and returns a
  genuine failure to the caller instead of "fired once and hoped" — so a dropped reply is
  no longer invisible.
- **KB topic name resolution: display `title` ≠ callable filename stem** (deferred
  2026-06-03). Fixed: `KnowledgeStore.readTopic` (`kb/core/src/knowledge-store/store.ts`)
  resolves by filename stem first, then falls back to a frontmatter-`title`→stem lookup, so
  the displayed name is also callable. (Note: the retrieval backend is now the LanceDB
  hybrid engine — the original note's orama `.vectors/orama.json` is obsolete; the index now
  lives at `.vectors/lancedb/`.)
