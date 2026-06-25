# KB data model & the link graph

What the knowledge base is *made of*, and how its pieces point at each other. Read this
first; the lint checks (`docs/components/kb-lint.md`) are all defined against the link
graph described here, so the findings only make sense once this model is clear.

## The four layers

The KB is a directory of Markdown files in four layers (the INDEX itself declares them):

| Layer | Location | What it is | Loaded at startup? |
|---|---|---|---|
| **L1 — index** | `INDEX.md` | The entry point / map. Either a hand-minimal architecture note (this KB) or an auto-generated topic catalog. | yes |
| **L2 — topics** | `topics/*.md` | **Distilled, structured knowledge** — the synthesized layer, the thing you actually search and read. | on demand (`kb_search` / `kb_read_topic`) |
| **L3 — logs** | `conversations/YYYY-MM-DD.md` | Daily logs: a `## TL;DR` plus `## Thread N:` sections — the time-ordered narrative of what happened. | today/yesterday TL;DR |
| **L4 — raw** | `raw/*.md` (+ the original session `.jsonl` behind them) | Captured transcripts — the immutable trace distillation mines. The `.jsonl` is the ultimate recording (git-backed, never loaded). | no |

**The flow:** a session is *captured* into `raw/` → *distilled* into `topics/` (knowledge)
and `conversations/` (the daily log) → only `topics/` is indexed for `kb_search`. Raw and
logs are source/trace; topics are the product.

```
session .jsonl ──capture──▶ raw/*.md ──distill──┬──▶ topics/*.md ──index──▶ kb_search
                                                 └──▶ conversations/YYYY-MM-DD.md
```

## The nodes and their metadata (frontmatter)

- **topic** (`topics/foo.md`): `title`, `description`, `tags`, and — for hub/sub-topic
  splits — `parent:` (points at the hub topic file) and `sub_topic:`. A big topic is split
  into a **hub** + several **sub-topics**, each sub carrying `parent: <hub>.md`.
- **raw** (`raw/<date>-<id>.md`): `id`, `session_id`, `distilled:` (true/false — the
  processed watermark), `topics:` (the list of topics this raw fed), plus watermark fields.
- **conversation** (`conversations/<date>.md`): `title`, `date`, `tags`; body is a **TL;DR**
  (a mandatory ≤10-line / ≤500-char summary block with 5 fixed anchors — core events,
  anchor corrections, lessons, numeric anchors, carry-over — loaded at startup as the day's
  compressed entry point) followed by **`## Thread N:`** sections (each a distinct topic of
  the day; legacy `## 主线 N:` also recognized). A long day chains into `-part2`, `-part3`
  via trailing links — the daily-log splitter cuts at a `## Thread` boundary.

## The edges (how files point at each other)

This is the graph lint inspects. There are five kinds of edge:

1. **wikilink** `[[target]]` — an Obsidian cross-reference inside a file's body. Resolves to
   another file by its **stem** (filename without `.md`) *or* its **title**. Forms:
   `[[stem]]`, `[[stem|label]]`, `[[topics/stem|label]]`, optionally with a `#heading`
   anchor. Used for topic→topic ("see also"), topic→source (cite the raw/log it came from),
   INDEX→topic (catalog), and log→log (split parts).
2. **`related:`** (topic frontmatter) — an explicit topic↔topic "see also" list.
3. **`parent:` / `sub_topic:`** (topic frontmatter) — the hub↔sub-topic hierarchy edge.
4. **`topics:`** (raw frontmatter) — the **back-ref**: which topics a raw was distilled
   into. This is the provenance edge, raw → topic ("this conversation's knowledge went
   *here*").
5. **`distilled:`** (raw frontmatter) — not an edge but the watermark that says a raw has
   been processed (so a `distilled: true` raw is *expected* to have a `topics:` back-ref).

```
            related: / [[wikilink]]            parent:
   topic ◀──────────────────────────▶ topic ◀──────── sub-topic
     ▲                                  ▲
     │ [[cite]]              topics:     │ [[cite]]
     │ (provenance)        (back-ref)    │
   raw  ───────────────────────────────▶ topic
   (distilled: true ⇒ should carry a topics: back-ref)
```

## Static view — what associates the layers, and by what mechanism

At rest, the four layers are tied together by **two independent association mechanisms**,
not one:

- **A) Authored links (the explicit graph).** Frontmatter fields + body wikilinks, written
  by the distiller (an LLM) and editable by hand:
  - `raw → topic`  via the raw's `topics:` back-ref (provenance: where this raw's knowledge
    went). Sometimes `topics:` points at `conversations/<date>` instead — "folded into that
    day's log, no standalone topic".
  - `topic → raw / log`  via a body `[[wikilink]]` citing the source.
  - `topic ↔ topic`  via `[[wikilink]]`, `related:`, and the `parent:`/`sub_topic:` hub
    hierarchy.
  - `INDEX → topic`  via `[[topics/x]]` — **but only in a catalog INDEX**.
  - `log ↔ log`  via `[[<date>-partN]]` chain links on split days.
- **B) The derived semantic index (no hand-links needed).** A separate LanceDB structure
  (vector embeddings + Chinese FTS) built over `topics/` only. This is what makes a
  *minimal* INDEX viable: the KB doesn't need a hand-maintained catalog because `kb_search`
  associates a query to the right topics semantically. The index is derived from topic
  content, not authored.

Two ties are **implicit / by-convention rather than by link**:

- `raw ↔ conversation` is mostly tied **by date** (a raw captured on the 16th is folded into
  `conversations/2026-04-16.md`); the daily log is a synthesized narrative and does not
  link back to individual raw files.
- `raw ↔ jsonl` is tied by `session_id` + the byte/offset watermark, not a wikilink.

So: the **explicit graph** (A) is what `ka kb lint` checks; the **semantic index** (B) is
what `kb_search` rides on. A minimal-INDEX KB leans on B and keeps A sparse on purpose.

## Runtime view — how the layers evolve

The layers are a one-way pipeline, each arrow gated by a **watermark** so the step is
incremental and never redoes work:

```
session .jsonl ──[offset/uuid watermark]──▶ raw/*.md ──[distilled: flag]──▶ topics/ + conversations/ ──[mtime manifest]──▶ LanceDB index
```

1. **Capture** (Stop hook / distill Phase 0): the live transcript is appended to
   `raw/<date>-<id>.md`. The `ka-jsonl-reader` CLI seeks to `last_parsed_offset` and returns
   only the delta (so a 50MB jsonl isn't re-read). New raw starts `distilled: false`.
2. **Distill** (background Opus, or foreground): reads every `distilled: false` raw and, per
   conversation, the LLM (a) appends knowledge to a matching `topics/*.md` with a
   `[[wikilink]]` citation **or** proposes a new topic into `pending-topics/` for approval;
   (b) writes/updates `conversations/<date>.md` (TL;DR + threads, auto-split at 1000 lines);
   (c) stamps the raw `distilled: true` + fills its `topics:` back-ref; (d) triggers reindex.
3. **Approve** (`/kb approve-topic`): moves a proposed topic from `pending-topics/` into
   `topics/` (and into a catalog INDEX, if that's the style).
4. **Reindex** (out-of-band): `incrementalReindex` re-embeds only topics whose `mtime` is
   newer than the index manifest's `source_mtime_max`, bumps the manifest version; the
   resident daemon reopens the table. Runs after distill and on daemon startup (self-heal).

The **watermarks** are what keep it convergent and idempotent: `last_parsed_offset` (don't
re-read the jsonl), `distilled:` (don't re-distill a raw), `source_mtime_max` (don't
re-embed an unchanged topic). Re-running any step with no new input is a no-op.

So a *single fact* travels: typed in a session → appended into a `raw` file → distilled into
a `topic` (and summarized into that day's `conversation`) → embedded into the search index →
retrievable by `kb_search`. Each hop leaves a back-link or a watermark so nothing is
processed twice and provenance is (meant to be) traceable end-to-end — and the lint findings
are exactly the places where one of those back-links got dropped.

## Lint findings, defined against the graph

Each `ka kb lint` finding is just a broken or missing edge:

| Finding | In graph terms | Plain meaning |
|---|---|---|
| **dead-wikilink** | a `[[target]]` edge whose target node doesn't exist | A link points to a topic/file that isn't there — renamed/deleted target, a CN display-name written where the file is english-stemmed, or a leaked template placeholder like `[[wikilink]]`. |
| **orphan-topic** | a topic node with no inbound edge from another topic | Nothing in the wiki links *to* this topic, so you can only reach it by search, never by browsing. |
| **index-drift** | INDEX's edge set ≠ topics on disk (catalog INDEX only) | The catalog lists topics that don't exist, or misses ones that do. Suppressed for a minimal INDEX (by design it links no topics). |
| **bad-frontmatter** | a topic node with malformed/missing metadata | Unparseable YAML (the topic silently vanishes from `kb_list_topics`), or missing `title`/`description` (shows degraded). |
| **raw-dangling-topic** | a raw's `topics:` back-ref edge points at a non-existent topic | A raw claims it fed a topic that isn't there (often a CN name vs english stem mismatch). |
| **raw-no-backref** | a `distilled: true` raw with no `topics:` edge | A processed raw recorded no provenance — you can't trace where its knowledge went. |

## Schema rule (owner-confirmed)

`topics:` on a raw may **only** name real topics — never a conversation, never empty. A
`distilled: true` raw must carry at least one real topic back-ref (even a "boring" one).
Pointing `topics:` at `conversations/<date>` breaks the schema's semantic definition. Lint
enforces this: an empty `topics:` → `raw-no-backref`; a conversation ref → the distinct
`raw-topics-not-a-topic` (schema violation). The orphan check honors `parent:` as an inbound
edge (a sub-topic's `parent: <hub>` references the hub).
