# Workspace Startup Context Architecture (Personal Universal Knowledge Base)

**Date**: 2026-05-25
**Trigger**: user feedback that "the agent has been acting dumber lately," suspecting the startup context loads too much, with redundancy, ambiguity, and "teaching a fish to swim."

This document records the complete design, decision rationale, and landed result of one startup-context refactor.

---

## 1. Background / problem diagnosis

### 1.1 Startup load before the refactor

| Source | Content | bytes | Notes |
| --- | --- | --- | --- |
| harness | system prompt | ~3KB | hardcoded by Anthropic |
| harness | system-reminders (skills / deferred tools / IDE) | ~10-15KB | dynamic |
| harness | `~/.claude/CLAUDE.md` global | 2.7KB | user-controlled |
| Read | SOUL.md | 1.7KB | serial at startup |
| Read | USER.md | 1.7KB | startup |
| Read | IDENTITY.md | 2.9KB | startup |
| Read | memory/INDEX.md | 7.0KB | startup |
| Read | memory/topics/rules.md | 9.2KB | startup |
| Read | today's daily log | ~8KB | startup |
| Read | yesterday's daily log | **27.9KB** | startup |
| Read | topics/\*.md triggered by the first message | 4-15KB | on demand |

Total baseline (excluding first-message topics): ~70KB ≈ **~18-22K tokens / startup**.
Yesterday's daily log alone takes up **40%**.

### 1.2 Three core problems

**A. Conflicts / duplication between documents**

- `CLAUDE.md` and `AGENTS.md` each defined their own startup order, contradicting each other (`AGENTS.md` didn't list IDENTITY.md)
- The "Memory" concept was defined separately in four places: SOUL / AGENTS / CLAUDE / rules
- The "use Chinese" instruction appeared in 5 places

**B. Single-file redundancy**

- 80% of `AGENTS.md`'s content (First Run / Heartbeats 82 lines / Discord emoji / sag voice / WhatsApp formatting) is irrelevant to this agent's environment
- `INDEX.md`'s status bar is overloaded (each topic stuffed with 3-5 anchor summaries)
- `rules.md`'s "rule-confirmation protocol" is a 30-line meta-rule + 3 empty heading placeholders
- a daily log averages 30KB / 600+ lines, but at startup all that's really needed is the 5 anchors + 5 actionables

**C. Teaching a fish to swim (generic chatbot scolding)**

- SOUL.md's "skip the 'great question!' pleasantries / don't be a corporate drone" — already covered by the system prompt
- AGENTS.md's "trash > rm / Don't exfiltrate" — generic safety scolding with no agent-specific context

---

## 2. Design principles (after the refactor)

1. **single source of truth** — each concept defined exactly once (memory in INDEX.md / persona in IDENTITY.md / core in SOUL.md / startup in AGENTS.md)
2. **workspace-bound** — the agent persona + personal fact base take effect only inside the workspace; other work workspaces run independently
3. **portable across LLM CLIs** — one AGENTS.md inside the workspace serves Claude Code / Codex / Cursor / Gemini at once, adapting to each CLI's default entry point via symlinks
4. **TL;DR-first for large files** — long daily logs pin a TL;DR at the top, startup only reads the first 30 lines, details Read on demand

---

## 3. The new architecture

```
┌─ ~/.claude/CLAUDE.md  (Claude Code global, injected into all workspaces)
│   • Auto Distill cron
│   • Daily Brief cron
│   • Telegram sync strategy
│   • ❌ does not reference any workspace
│   • ❌ no startup protocol
└─

┌─ <your-workspace>/CLAUDE.md   ← symlink → AGENTS.md
│  ↓ harness auto-injects when Claude Code enters the workspace
│
├─ <your-workspace>/GEMINI.md   ← symlink → AGENTS.md (added on demand)
│
└─ <your-workspace>/AGENTS.md   ← universal KB entry point (the real file)
   §1 Startup Protocol (read 7 files in parallel)
   §2 First user message routing
   §3 Memory Architecture (pointer → INDEX.md)
   §4 Post-Compaction Recovery
   §5 Operating Principles (Safety / Internal vs External / Write It Down / Mate collaboration)
   §6 LLM CLI adaptation table
   ↓ Codex reads this file directly when it enters the workspace (default behavior)

┌─ knowledge-assistant/CLAUDE.md   ← harness auto-injects when ka-dev2 starts
├─ freelancer/CLAUDE.md            ← when freelancer starts
└─ work-assistant/CLAUDE.md        ← when work-assistant starts
   • project-specific guidance
   • completely independent of the workspace
   • the mate obtains the user context it needs via SendMessage from the main session
```

### 3.1 Core insight

- **the workspace is not a workspace, it's a universal entry point** — the canonical storage for the user's personal fact base + the agent persona; effective only when cwd is the workspace
- **work workspaces each have their own CLAUDE.md / GEMINI.md** — project-specific, not referencing the workspace; the user context a mate needs is pushed explicitly by the main session via SendMessage
- **the LLM global config holds only cross-workspace tool-specific behavior** (cron / Telegram), no workspace-specific paths
- **symlinks are made inside the workspace** — letting multiple CLIs share the same AGENTS.md content, avoiding maintaining multiple copies

### 3.2 The three-layer hierarchy

| Layer | File | Scope | Load method |
| --- | --- | --- | --- |
| L1 tool global | `~/.claude/CLAUDE.md` etc. | cross-workspace | harness auto-inject |
| L2 workspace entry | `<workspace>/CLAUDE.md` (= symlink) | a single workspace | harness auto-inject when cwd == workspace |
| L3 real content | `<workspace>/AGENTS.md` | a single workspace | symlink target / Codex direct read |

---

## 4. Per-file change list

| File | Change | Benefit |
| --- | --- | --- |
| `~/.claude/CLAUDE.md` | drop the Session Startup Protocol; keep only cron + Telegram | 47 → 36 lines |
| `<your-workspace>/AGENTS.md` | rewrite as a universal KB entry point (6 sections) | 229 → 80 lines (-7.3KB) |
| `<your-workspace>/CLAUDE.md` | **create symlink** → AGENTS.md | auto-loaded by Claude Code |
| `<your-workspace>/SOUL.md` | drop Boundaries / Vibe / Continuity (migrated to AGENTS / INDEX); keep the 5 core truths | 36 → 18 lines |
| `<your-workspace>/IDENTITY.md` | localized headings; move out Workshop Team (→ tools.md) | 63 → 38 lines |
| `<your-workspace>/memory/INDEX.md` | add a Memory Architecture section at the top (the single definition of L1-L4) | +12 lines |
| `<your-workspace>/memory/topics/tools.md` | append the Workshop Team anchor + N+30 lesson at the end | +27 lines |
| `<your-workspace>/memory/topics/rules.md` | drop the "memory recovery" section (migrated to INDEX); rule-confirmation protocol 20 → 1 line; fill the 3 empty headings with short content; add the TL;DR protocol rule | 149 → 80 lines |
| `memory/conversations/2026-05-24.md` | add a TL;DR at the top (5-line summary) | +15 lines |
| `memory/conversations/2026-05-25.md` | add a TL;DR at the top | +15 lines |

---

## 5. The TL;DR protocol (key)

### 5.1 Template

Every `memory/conversations/YYYY-MM-DD.md` **must** begin with `## TL;DR`:

```markdown
---
title: YYYY-MM-DD daily
date: YYYY-MM-DD
tags: [daily]
---

## TL;DR

- **Core events**: 1-2 key event anchors
- **Anchor corrections**: key anchor updates (location / preferences / ingredients / decisions)
- **Lessons**: N+X user lessons + meta-rule reinforcement
- **Numeric anchors**: amounts / times / data
- **Carry-over**: actionables to follow up the next day

---

# YYYY-MM-DD — title

## Thread 1: ... (detailed content)
```

Constraint: **≤ 10 lines / ≤ 500 characters**, fitting on a single screen.

### 5.2 Load flow

```
LLM startup
  ↓
Read(today.md, limit: 30)    ← read only the TL;DR + the first few thread headings
Read(yesterday.md, limit: 30) ← same
  ↓
user asks a question
  ↓
Does the TL;DR already cover this topic?
├─ yes → answer directly (don't read the full daily)
└─ no → which day does it involve?
        ├─ today / yesterday → Read(full) without limit
        └─ further back → route through INDEX to topics/*.md
```

### 5.3 Ongoing maintenance

- The `/kb distill` flow should auto-generate the TL;DR when producing a daily log (pending knowledge-assistant integration)
- The existing 5/24 + 5/25 already have hand-written TL;DRs; the last 5-7 days can be batch-backfilled as examples

---

## 6. Mate collaboration model

### 6.1 The agent vs the mate

- **the agent** (main session in the workspace) = the workshop main pane
- **the mate** (ka-dev2 / freelancer / work-assistant) = collaboration agents running independently inside their own work workspaces

### 6.2 Context flow

- a mate **does not read** the workspace's AGENTS.md at startup
- a mate only reads its own workspace's `CLAUDE.md` (project-specific guidance)
- when it needs user preferences / personal facts → these are pushed explicitly by the main agent via `SendMessage`

### 6.3 Anti-patterns to avoid

- ❌ a mate claiming to be the main agent (persona confusion)
- ❌ a mate reading unrelated workspace files from its own cwd (cache pollution + attention scatter)
- ❌ anchors going out of sync between mates (because each silently loads a different version of the workspace)

---

## 7. Benefit estimate

| Item | Before | After | Saved |
| --- | --- | --- | --- |
| ~/.claude/CLAUDE.md | 2.7KB | 1.2KB | -1.5KB |
| AGENTS.md | 9.3KB | 3.1KB | -6.2KB |
| SOUL.md | 1.7KB | 1.1KB | -0.6KB |
| IDENTITY.md | 2.9KB | 1.8KB | -1.1KB |
| rules.md | 9.2KB | 8.8KB | -0.4KB |
| today's daily (actually read at startup) | 8KB | ~0.6KB (limit:30) | **-7.4KB** |
| yesterday's daily (actually read at startup) | 27.9KB | ~0.6KB (limit:30) | **-27.3KB** |
| **controllable startup tokens** | **~22K** | **~6-8K** | **-65%** |

Additional benefits (harder to quantify):
- higher cache hit rate → lower response latency
- single source of truth → fewer self-contradictory instructions
- portable across LLM CLIs → switching to Codex / Gemini in the future needs no workspace reconfiguration

---

## 8. Verification checklist

Verify at the next session startup:

- [ ] the `~/.claude/CLAUDE.md` global config contains only cron + Telegram, no workspace paths
- [ ] when Claude Code enters the workspace, the harness injects CLAUDE.md = the content of AGENTS.md
- [ ] the agent Reads the 7 files in parallel per AGENTS.md §1 (not serially)
- [ ] the daily log uses `Read(limit: 30)` to read only the TL;DR
- [ ] the mate (ka-dev2) **does not read** the workspace's AGENTS.md at startup
- [ ] total startup tokens drop from ~22K to ~6-8K (check the prompt cache stats)

---

## 9. Known leftovers / future work

### 9.1 Not done this time

- **Splitting the INDEX.md status bar** (P1) — the 3-5 anchor summaries per line for 22 topics are still inside INDEX.md; an INDEX-STATUS.md could be split out so startup only reads the routing table
- **Creating `rules-archive.md`** (P1) — archiving dated lessons > 60 days old; the current rules.md still has some early content
- **kb distill integrating the TL;DR** (P0 but requires changing KA) — the TL;DR is hand-written now; `/kb distill` should produce it automatically

### 9.2 Future LLM onboarding

- For future Gemini CLI use: `cd <your-workspace> && ln -s AGENTS.md GEMINI.md`
- For future Codex CLI use: no action needed (Codex reads AGENTS.md by default)
- For future Cursor use: no action needed (recent Cursor also reads AGENTS.md)

### 9.3 Cross-workspace consistency

The `CLAUDE.md` of each work workspace (knowledge-assistant / freelancer / work-assistant) is currently **unaudited** and may still have its own duplicated startup content; the same refactor principles can be applied workspace by workspace later.

---

## 10. Decision log (why this, not that)

| Choice | Selected | Alternative | Why |
| --- | --- | --- | --- |
| Whether the LLM global config symlinks directly to `<your-workspace>/AGENTS.md` | No, keep it a standalone file | symlink ~/.claude/CLAUDE.md → `<your-workspace>/AGENTS.md` | the global config is injected across all workspaces; if it links to a specific workspace, other workspaces get wrongly injected too |
| Is AGENTS.md or CLAUDE.md the source of truth | AGENTS.md | CLAUDE.md | AGENTS.md is portable across CLIs (Codex / Cursor read it by default), while CLAUDE.md is a Claude-Code-private convention |
| Symlink direction | CLAUDE.md → AGENTS.md | AGENTS.md → CLAUDE.md | AGENTS.md is the broader convention (multi-CLI), so it makes more sense as the source |
| How to land the daily-log TL;DR | same file + `Read(limit:30)` | a separate daily-TLDR-YYYY-MM-DD.md file | a single file is easier to maintain; the limit parameter is precise enough |
| Whether the mate loads the agent persona | No (mates are independent) | the mate also loads IDENTITY.md | a mate is not the main agent; forcibly loading it causes persona confusion; the context a mate needs is pushed explicitly by the main agent |
| Whether AGENTS.md keeps the LLM adaptation table | keep §6 | move it to README.md to shrink LLM context | the adaptation table is short (5 lines) and useful to the LLM too (knowing which CLI it's in) |

---

## Appendix: full before/after comparison

**Startup before the refactor** (the agent's perspective):

```
1. system prompt + system reminders + ~/.claude/CLAUDE.md  (harness inject)
2. Read <your-workspace>/SOUL.md
3. Read <your-workspace>/USER.md
4. Read <your-workspace>/IDENTITY.md
5. Read <your-workspace>/memory/INDEX.md
6. Read <your-workspace>/memory/topics/rules.md
7. Read today.md (full 8KB)
8. Read yesterday.md (full 28KB)
9. first user message → Read topics/*.md
```

**Startup after the refactor** (the agent's perspective):

```
1. system prompt + system reminders  (harness inject)
2. harness auto-inject ~/.claude/CLAUDE.md (1.2KB, cron + Telegram only)
3. harness auto-inject <your-workspace>/CLAUDE.md (= AGENTS.md, 3.1KB)
4. Read 7 files in parallel per AGENTS.md §1:
   - USER.md / SOUL.md / IDENTITY.md / INDEX.md / rules.md
   - today.md (limit:30, ~0.6KB)
   - yesterday.md (limit:30, ~0.6KB)
5. first user message → Read topics/*.md in parallel per INDEX.md routing
6. user question touches details of a given day → Read the full daily log on demand (no limit)
```

---

**Source**: workspace session 2026-05-25 with the user; the detailed conversation flow is in `<your-workspace>/memory/conversations/2026-05-25.md`.
