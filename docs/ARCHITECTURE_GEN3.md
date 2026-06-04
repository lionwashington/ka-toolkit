# KA Architecture — gen3: the four functional parts

> Status: **ka-gen3 design contract** (draft for review). Complements
> `ARCHITECTURE.md` (the vertical layer model: Agent → KA → runtime → host).
> This doc decomposes **the KA layer itself** into four functional parts and
> defines the design-side package reorganization. It changes **no runtime
> behavior** — gen3 reorganizes source only; the runtime deploy layout is
> unchanged (runtime restructuring is deferred to gen4).

## 1. Why four parts

`ARCHITECTURE.md §1` stacks four *layers* (Agent / KA tool system / runtime /
host) — that's "what runs on what". This doc cuts a different axis: **the one KA
layer is itself four functional parts**, each a distinct concern:

| # | Part | Concern | One-line role |
|---|------|---------|---------------|
| 1 | **KB + capability** | capability | give a *single* agent runtime more ability |
| 2 | **workshop** | orchestration | manage *many* co-located runtimes |
| 3 | **channels** (daemon) | communication | message in/out + runtime↔runtime |
| 4 | **cron** | scheduling | fire things on a schedule |

Capability · orchestration · communication · scheduling. The split is clean
because the four answer four different questions: *what can one agent do*, *how
do many agents coexist*, *how do they talk*, *when do things run*.

## 2. The four parts

### Part 1 — KB + capability (per-runtime capability)

Everything that makes **one** agent runtime more capable. Runtime-agnostic where
possible; the agent calls these as tools/skills.

- **kb core**: capture → distill → deposit → query of LLM conversations into an
  Obsidian-compatible Markdown KB (`packages/core`). Includes the headless
  background distiller (`ops/kb/distill-bg.sh` + `ops/kb/distill-bg-worker.sh`)
  and the capture hook.
- **kb MCP server**: `kb_search` / `kb_read_topic` / `kb_list_topics` /
  `kb_status` (`packages/mcp-server`).
- **skills**: `/kb`, daily-brief, mail, calendar, jd, taobao-native, …
  (`packages/skill`, `packages/skills`).
- **MCP tool servers**: hkprop, ibkr, market-data, opennutrition — domain tools
  the agent calls (`packages/hkprop-mcp`, `ibkr-mcp`, `market-mcp`,
  `mcp-opennutrition`).

Boundary: part 1 is *consumed by* a runtime; it does not orchestrate runtimes,
move messages, or schedule. (distill is part 1; the cron job that *triggers*
distill is part 4.)

### Part 2 — workshop (multi-runtime orchestration)

Brings up and manages **multiple** agent-runtime processes, each in its own tmux
pane + cwd, and gives them a *direct* collaboration mechanism.

- **lifecycle / management**: `ka workshop [start|stop|restart|spawn-mates]`,
  `workshop.yaml` (the merged `mates:` schema), pane/window layout, cwd
  guarantee, the dev-channels gate (`ops/cli/workshop.sh`, `ops/lib/start-pane.sh`,
  `ops/lib/yaml-parse.sh`, `tmux-helpers.sh`, `inject-prompt.sh`, `wait-ready.sh`).
- **tmux-native collaboration** (one of two collab modes, see Part 3): a CC
  reads another pane's screen (`capture-pane`) and injects keystrokes
  (`send-keys`) — used by `inject-prompt` / `wait-ready`.

Boundary: workshop owns *processes + panes + tmux collaboration*. It does **not**
own the messaging channel (that's Part 3) — gen3 removed all daemon management
from `ka workshop` (it only warns if the daemon is down).

### Part 3 — channels / daemon (communication)

The communication layer. A single long-lived **channel daemon** (telegram or
lark) speaks MCP-over-HTTP and provides two things:

- **external IM ↔ runtime**: owner ↔ CC over Telegram/Lark (`reply`,
  routing with `to <name>:`).
- **runtime ↔ runtime**: `send_to_channel` (cc2cc) — the *second* collaboration
  mode (structured, named/numbered message passing; complements Part 2's tmux
  mode).

Code: `packages/channel-core` (platform-independent kernel: routing / dispatch /
sessions / http) + `packages/telegram-channel`, `packages/lark-channel`
(platform adapters). Managed by `ka daemon [start|stop|restart|status|config]`.
The active kind + port come from `config.yaml channel_kind` +
`runtime/<kind>-daemon/config.json` (gen2.x single-source-of-truth).

Boundary: channels owns *message transport*. It does not spawn/manage runtimes
(Part 2) or schedule (Part 4).

### Part 4 — cron (scheduling)

Declarative OS-level scheduling — `ka cron` + `cron.yaml`, deployed to launchd
(macOS) / crontab (Linux) (`ops/cli/cron`, `ops/lib/cron`,
`ops/scripts/cron-run.sh`).

Boundary: cron is **cross-cutting** — it owns *when*, not *what*. The jobs it
fires belong to other parts (kb-distill → Part 1, daily-brief → Part 1 skill,
daemon self-heal → Part 3). It is a standalone part because it has its own
management surface, but conceptually it is a scheduling *service* for Parts 1–3.

## 3. Dependencies between the parts

```
   Part 4 cron ──fires──▶ Part 1 (distill/brief) · Part 3 (daemon self-heal)
   Part 2 workshop ──messages via──▶ Part 3 channels (cc2cc / owner reply)
   Part 1 capability ◀──called by── the agent runtime (each pane is a runtime)
```

- Part 2 **depends on** Part 3 for messaging (but launches panes regardless of
  daemon state — it only warns).
- Part 4 **drives** Parts 1 & 3 (triggers their jobs).
- Part 1 is **leaf** — consumed by the runtime, depends on none of 2/3/4
  (the distill *cron* is Part 4, not part of part 1's core).
- Part 3 is **leaf** for transport — depends on none of 1/2/4.

The acyclic shape (4 → {1,3}; 2 → 3; 1,3 leaves) is what makes the split clean.

## 4. Cross-cutting

- **`ka` CLI** (`bin/ka`): the single management entry. Its verbs already map to
  the parts — `ka workshop` (2), `ka daemon` (3), `ka cron` (4), `ka distill`
  (1). It is cross-cutting, not a fifth part.
- **config**: `config.yaml` (KB paths, channel_kind, capture/inject) +
  `workshop.yaml` (Part 2) + `cron.yaml` (Part 4) + per-daemon `config.json`
  (Part 3).
- **design / runtime separation** (`ARCHITECTURE.md §4`, non-negotiable): source
  lives in this repo; `install.sh` produces the runtime under
  `~/.knowledge-assistant/runtime/`. gen3 changes only the source organization.

## 5. The standard (one axis) and why today is inconsistent

Today the repo mixes **four different axes** with no single rule:

- by **artifact type**: `packages/` (TS) vs `ops/` (sh) vs `tests/`
- by **role**: `ops/cli/` (entries) vs `ops/lib/` (libraries) vs `ops/scripts/`
- by **functional part**: `ops/kb/` (just added)
- by **data**: `ops/panes/`

…plus config templates scattered (`config/` has only config+secrets; the
workshop template sits in `ops/`, the daemon templates in `packages/`, cron has
none) and **two** `scripts/` dirs (root `scripts/e2e-test.sh` vs
`ops/scripts/cron-run.sh`). That is the "no clustering" the owner flagged.

**The gen3 standard — a single axis:** organize the **whole repo by the four
functional parts**, plus exactly three non-part buckets. Every top-level dir is
one of: a **part** (`kb` / `workshop` / `channels` / `cron`), the **shared**
cross-cutting bucket, **config** (all templates), or **tests** (the harness).
Nothing is organized by artifact-type or role at the top level any more.

## 6. Final target structure

```
ka-toolkit/
├── kb/             Part 1 — KB + capability (per-runtime ability)
│   ├── core/             capture · distill · retrieval · knowledge-store   (TS, was packages/core)
│   ├── mcp-server/       kb_search / kb_read_topic / …                      (TS, was packages/mcp-server)
│   ├── skill/  skills/   /kb + daily-brief · mail · calendar · jd · …       (was packages/skill, /skills)
│   ├── tools/            domain MCP servers: hkprop · ibkr · market · nutrition  (was packages/*-mcp)
│   ├── adapter-cc/       cc capture-hook + install                          (was packages/adapters/claude-code)
│   └── ops/             distill-bg.sh · distill-status.sh · distill-bg-worker.sh
├── workshop/       Part 2 — orchestration (sh only; no TS package)
│   └── ops/             workshop.sh · start-pane.sh · tmux-helpers.sh · yaml-parse.sh ·
│                        inject-prompt.sh · wait-ready.sh · yaml-upsert-mate.py · runtimes/cc · panes/
├── channels/       Part 3 — communication (the daemon)
│   ├── core/             channel-core kernel: routing · dispatch · sessions · http   (TS)
│   ├── telegram/         telegram platform adapter                          (TS, was packages/telegram-channel)
│   └── lark/             lark platform adapter                              (TS, was packages/lark-channel)
├── cron/           Part 4 — scheduling (sh only)
│   └── ops/             cron.sh · cron/<internals> · cron-run.sh · maintenance/
├── shared/         cross-cutting (spans all parts — not a part itself)
│   ├── bin/ka            the dispatcher (routes `ka workshop|daemon|cron|distill|…`)
│   └── ops/             common.sh · doctor.sh · status.sh · help.sh
├── config/         ALL config templates, centralized
│   ├── config.example.yaml · secrets.example.yaml
│   ├── workshop.example.yaml · cron.example.yaml
│   └── telegram-daemon.example.json · lark-daemon.example.json
├── tests/          cross-cutting test infrastructure (the Docker harness + cases)
├── docs/  ·  install.sh  ·  pnpm-workspace.yaml  ·  package.json  ·  tsconfig.base.json
```

### Why each thing lands where (rationale)

- **Each part is self-contained**: a part holds *everything* it owns — its TS
  package(s), its sh tooling, nothing scattered. Read `kb/` and you see the whole
  KB part; you never hunt across `packages/` + `ops/cli` + `ops/lib`.
- **`shared/` exists because some code genuinely spans parts**: `common.sh`
  (sourced everywhere), the `ka` dispatcher (routes to all parts), and
  `doctor`/`status` (report across workshop + daemon + cron + kb). Forcing these
  into one part would be wrong — so one explicit cross-cutting bucket, no more.
- **`config/` centralizes ALL templates** (problem 2): config + secrets +
  workshop + cron + per-daemon templates live in one place; the runtime still
  reads its live copies from `~/.knowledge-assistant/`.
- **`tests/` is the one infra bucket** (problem 1/3): the Docker harness tests
  *all* parts, so it isn't a part; the root `scripts/e2e-test.sh` folds in here,
  and `ops/scripts/cron-run.sh` goes to `cron/` (it's cron's entrypoint). The two
  stray `scripts/` dirs disappear.
- **No top-level `packages/` vs `ops/`** (problems 1 & 4): the TS-vs-sh
  distinction becomes a *sub-detail inside a part* (`kb/core` is TS, `kb/ops` is
  sh), not a top-level axis. pnpm workspace globs change from `packages/*` to the
  part dirs (`kb/*`, `channels/*`).
- **workshop & cron have no TS** — they're pure sh, so they're just
  `workshop/ops/` and `cron/ops/`. That's expected, not a gap.

### Migration implications (all design-side; runtime untouched)

- `pnpm-workspace.yaml` globs + every cross-package TS import path (e.g.
  `mcp-server` → `core`, `telegram` → `channel-core`) get rewritten to the new
  locations.
- `install.sh` source paths get rewritten — but it deploys into the **same**
  runtime layout (`runtime/ops`, `runtime/core-cli`, `runtime/<kind>-daemon`, …),
  so the running system is unaffected (gen3 rule).
- `tsup`/`esbuild` entry paths + `tests/` references updated accordingly.

## 7. Execution plan

**gen3 (this branch) — design reorg, runtime layout UNCHANGED:**

1. This doc (the contract) → owner approves the final structure **first**.
2. Then move **one part at a time**, Docker-green after each (repo always green;
   nothing big-bang). (The earlier lone `ops/kb/` move is folded into this — it
   gets re-aligned to the agreed structure.)
3. `install.sh` maps new source paths → the **existing** runtime layout.
4. Full verification = build all packages + ops Docker suite + channel e2e
   (telegram/lark fakes) + each MCP smoke, all green.
5. `install.sh` → runtime on this Mac → tests pass.
6. `install.sh` → runtime on the Ubuntu machine → tests pass.

Because the running runtime keeps the old deployed code until step 5, **the
production system has zero risk through the entire design reorg.**

**gen4 (later)** — restructure the **runtime** layout to mirror the four parts
(changes `install.sh` deploy paths). Deferred; out of scope for gen3.

> Decision needed from the owner: confirm this final structure. The one judgment
> call is **§6's "no top-level packages/ vs ops/"** — fully by-part (recommended,
> answers all four problems, but rewrites pnpm-workspace + TS imports) vs a
> lighter variant that keeps `packages/` and `ops/` at the top but sub-groups
> each by part (less churn, but retains the artifact-type split the owner
> flagged). Recommendation: the fully by-part structure above.
