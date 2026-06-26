# KB self-check & repair — the 3-step plan

Inspired by Karpathy's "LLM Wiki" third pillar (**lint** — periodic health checks for
contradictions, stale claims, orphan pages, broken cross-references). Our KB has the first
two pillars (raw/synthesized separation + LLM-maintained ingest) but no self-check layer.
This plan closes that gap in three independent, sequenced steps.

Status (2026-06-26):
- **Step 1 — detection: DONE + shipped.** `ka kb lint` built, unit-tested, deployed; run
  against the real KB; cross-validated (an independent count matched all 10 metrics).
- **Step 2 — remediation: DONE.** The initial debt was cleared — dead links / orphans /
  bad frontmatter hand-fixed, and the 110 missing/invalid `topics:` back-refs backfilled by
  an Opus pass (noise → `noise-spawn-handshake`, substantive → real topics). KB now reports
  201/201 distilled, 0 dead links, 0 orphans (non-meta/noise) — lint clean.
- **Step 3 — prevention: PARTIAL.** Standing guardrails landed (the bounded distill
  backlog-drain; `raw-undistilled` lint check). **Still pending:** distill-prompt hardening
  (CN→stem + always-write `topics:`) and the semantic `--deep` contradiction check (check 6).

Owner approved the 5 decision points and the 3-step structure.

---

## Real-KB baseline (read-only scan, via main's sub-agent)

Scale: **61 topics · 109 conversations · 201 raw**.

Two systemic problems dominate — both are really **distill-quality bugs** lint surfaces as
symptoms:

- **CN↔EN naming mismatch** — distill writes `[[中文名]]` / `topics: [中文名]` but files are
  english-stemmed (a CN display name vs its english file stem). Root cause of most of the
  16 dead links and the 41 dangling raw→topic refs.
- **Missing back-refs** — 135 of 201 raw are `distilled: true` with empty/absent `topics:`.
  Over half the corpus has no provenance link from raw to the topics it fed.

Full debt inventory — counts below are from the deployed `ka kb lint` run against the
real KB (ground-truth, independently re-verified against the raw frontmatter; an earlier
manual sub-agent scan overcounted no-backref as 135 and dead links as 16):

| Problem | Count | Severity | Remediation |
|---|---|---|---|
| Dead wikilinks in topics + INDEX | 13 | error | mixed (see classes below) |
| Dead wikilinks in conversations (append-only logs) | 14 | warning | low priority |
| Bad/degraded frontmatter (`name:` instead of `title:`) | 1 | warning | tier-1 deterministic |
| Orphan topics (no cross-link, even via `parent:`) | 4 | warning | owner: link or accept |
| `raw topics:` points at a conversation (schema violation) | 29 | warning | re-attribute to a real topic |
| `raw topics:` names a non-existent topic | 9 | warning | fix name (mostly renames) |
| Distilled raw with no back-ref (`topics:` empty) | 81 | info | backfill a real topic |

The 13 topic/INDEX dead links break into: leaked template placeholders (`[[wikilink]]`,
`[[<date>-part<N>]]`, `[[<date>]]`, `[[<上一段>]]` — tier-1, delete), CN content mistakenly
wikilinked (tier-1, unlink), and renamed/missing topics (tier-2, pick the target).

Owner decision (confirmed): `topics:` may only name a real topic — never a conversation,
never empty. So the 29 conversation-refs + 81 empties = **110 raws need a real topic
back-ref** (decision: do the backfill). Method is open — topics cite `conversations/<date>`
(~525×) far more than raw (~31×), so a deterministic reverse-fill from topic→raw citations
covers little; the realistic options are LLM re-read, a date-bridge (raw → topics that cite
its day's log, over-inclusive), or a hybrid (date-bridge candidates + LLM pick).

> "No back-ref" = a raw is `distilled: true` but its `topics:` is empty and no topic links
> back — the provenance link is missing. Knowledge may still live in a topic; what's lost
> is the trace of *where it went*.

Two design facts the scan forced (both already baked into this plan):

- **Resolver must span `topics ∪ conversations ∪ raw`** (stem + title, strip `.md` +
  `#anchor`). ~500 `[[conversations/*]]` + ~25 `[[raw/*]]` links point at real non-topic
  files; a topics-only resolver would false-positive all of them.
- **This KB's `INDEX.md` is intentionally minimal** (10 lines, declares routing is
  `kb_search`-only). So "topic on disk but missing from INDEX" is by-design for all 61 —
  orphan/drift checks must NOT treat INDEX as a topic catalog.

---

## The model: prevention + detection + remediation

A hardened distill prompt is **probabilistic prevention, not a cure** — distill is a
non-deterministic LLM pass, so defects still slip through and existing debt is untouched
either way. Three complementary legs, executed as three steps:

- **Detection** (Step 1) — `ka kb lint`. Ongoing safety net; the tool everything else needs.
- **Remediation** (Step 2) — one-time clearing of the existing 16+1+41+135 debt.
- **Prevention** (Step 3) — distill hardening (stop new debt) + the semantic `--deep` check
  + standing guardrails (doctor/cron).

---

## STEP 1 — Detection: build `ka kb lint` (deterministic, no LLM)

**Goal:** an ongoing, cheap, read-only self-check that surfaces every structural problem.

**Architecture**
- `kb/core/src/lint/lint.ts` (pure logic) + `lint-cli.ts` (CLI). Pure JS, no native deps,
  no model load — same tier as `daily-log-splitter-cli`. Deployed as a core-cli via
  `install.sh`; `ka kb lint` ops wrapper. Resolves `knowledge_base_path` from `config.yaml`.
- One cheap pass: parse all `topics/*.md` (frontmatter+body), `INDEX.md`, `raw/*.md`
  (frontmatter), list `conversations/` into an in-memory model; run all checks against it.
- **Shared wikilink resolver:** parse `[[x]]` / `[[x|label]]` / `[[topics/x|label]]`, strip
  `#anchor` + `.md` + dir prefix; resolves if target matches a **stem or title** of any
  file in `topics ∪ conversations ∪ raw`.
- **Output:** human report (grouped by severity) + `--json`. **Exit codes:** `0` clean /
  `1` warnings / `2` errors.

**The 5 deterministic checks**
1. **Dead wikilinks** (error) — any `[[...]]` resolving to nothing. Report `file · link · line`.
2. **Orphan topics** (warning) — topic not cross-linked by any other topic's body
   `[[wikilink]]` or `related:`. INDEX-independent (see baseline note).
3. **INDEX drift** (warning) — auto-detects INDEX style: if INDEX has zero `[[topics/*]]`
   links it's *minimal* → suppress the "missing from INDEX" direction (no 61-false-alarm);
   always flag dangling INDEX entries (dead links). Only a *catalog* INDEX gets full drift.
4. **Bad / invisible frontmatter** (error) 🔴 — topics whose YAML fails to parse, or lack
   `title`/`description`, or duplicate `title` (one shadows the other). These vanish from
   `kb_list_topics` today with no signal anywhere.
5. **raw↔topic linkage** — (a, warning) `topics:` listing a nonexistent topic; (b, info)
   `distilled: true` raw with no back-ref.

**`--fix` (Step-1 scope, owner-confirmed):** regenerate a *catalog* `INDEX.md` only (reuse
`store.updateIndex()`). Deterministic + safe. Never touches content or a minimal INDEX.

**Integration:** add a lint coverage check to `ka doctor` (run `lint --json`, surface
error-count). Unit tests for the resolver + each check (fixtures covering the real bug
classes: `.md` suffix, CN name, `name:` vs `title:`, minimal vs catalog INDEX).

---

## STEP 2 — Remediation: clear the existing debt (one-time, reviewed)

**Goal:** drive the 16+1+41+135 debt to ~0. Separate from Step-1 auto-`--fix`; tiered by
safety. Re-run `ka kb lint` after to confirm.

- **Tier 1 — deterministic & unambiguous → `--fix-safe` (explicit opt-in flag):** strip a
  stray `.md` suffix in a link (`[[stem.md]]`→`[[stem]]`); `name:`→`title:` key rename; a
  CN-name dead link mapping to **exactly one** topic stem (`[[中文名]]`→its unique english
  stem). Mechanical, no judgment.
- **Tier 2 — needs intent → report + nearest-match suggestion, human applies:** a mis-named
  link that needs a human to pick the intended target, broken placeholder links, and leaked
  template placeholders (`[[wikilink]]`, `[[<date>-part<N>]]`).
- **Tier 3 — needs LLM re-read → one-time background Opus backfill:** the 135 missing
  back-refs. Re-read each `distilled:true` raw, judge which topics it fed, write **proposed**
  `topics:` to a review queue (`pending-lint/`) — never blind. Owner approves before apply.

---

## STEP 3 — Prevention: stop new debt + semantic check + standing guardrails

**Goal:** keep the debt at ~0 after Step 2, and add the semantic pillar.

- **Distill-prompt hardening** (kb skill / distill prompt): (a) emit canonical english
  **stems** for every `[[wikilink]]` and `topics:` entry (CN display name → stem mapping);
  (b) always write the `topics:` back-ref when marking a raw `distilled: true`. This lowers
  the *rate* of new defects (not to zero — that's why Step-1 lint stays as the net).
- **Check 6 — contradictions & stale claims** (`ka kb lint --deep`, LLM, phase 2): background
  Opus pass flags intra-/cross-topic contradictions and claims superseded by newer dated
  info; writes findings to `pending-lint/` for human review — never auto-edits. Needs a
  candidate filter (shared tags / recently-changed) to avoid O(n²) token cost.
- **Standing guardrails:** `ka doctor` surfaces lint error-count every run; optional weekly
  cron `ka kb lint` that Telegram-pushes a summary only when errors > 0.

---

## Confirmed decisions

1. Severity→exit codes (error=2 / warning=1), surfaced in `ka doctor`. ✅
2. `--fix` limited to INDEX regeneration; all content fixes are explicit/tiered (Step 2),
   never auto-delete/rewrite. ✅
3. Check 6 = separate `--deep` background pass → `pending-lint/`, phase 2 (Step 3). ✅
4. Check 5(b) (135 no-back-ref) kept at **info** severity (half the corpus — surfacing is
   the point, but not a wall of red). ✅
5. Distill-prompt hardening done as prevention (Step 3), paired with — not replacing —
   lint. ✅

## Sequencing

Step 1 first (the tool everything needs) → Step 2 (clear existing debt, tiers in order) →
Step 3 (prevention + semantic + guardrails). Steps are independent and can ship in batches;
re-run `ka kb lint` between steps to measure progress.
