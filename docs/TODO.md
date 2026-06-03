# TODO / Backlog

## KB topic name resolution: display name ≠ callable name

**Bug.** `kb_list_topics` displays each topic's frontmatter `title`, but
`kb_read_topic(name)` resolves the file by **filename stem** (`<name>.md`). When a
topic's `title` differs from its filename (e.g. file `todo.md` with `title: "Todo list"`),
a caller that takes the displayed title and calls `kb_read_topic("Todo list")` gets
`ENOENT` — the displayed name is not the callable name. This is systemic: most topics
use an English kebab-case filename with a longer/localized title.

Root cause is in `packages/core/src/knowledge-store/store.ts`:
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
