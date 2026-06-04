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

## 5. Current → target package mapping (the gen3 reorg)

Today the source maps to the four parts **unevenly** — Part 3 is already clean,
but Parts 1/2/4 are interleaved (esp. `ops/` is a mixed bucket of workshop +
cron + distill sh). gen3 regroups source so each part is self-contained.

| Part | Already-aligned source | Interleaved / to regroup |
|------|------------------------|--------------------------|
| 1 KB+capability | `packages/core`, `mcp-server`, `skill(s)`, `*-mcp` | `ops/kb/distill-bg.sh`, `distill-status.sh`, `ops/kb/distill-bg-worker.sh` (KB sh currently in ops/) |
| 2 workshop | — | `ops/cli/workshop.sh`, `ops/lib/start-pane.sh`, `tmux-helpers.sh`, `yaml-parse.sh`, `inject-prompt.sh`, `wait-ready.sh`, `yaml-upsert-mate.py` (mixed in ops/) |
| 3 channels | `packages/channel-core`, `telegram-channel`, `lark-channel` | — (already clean) |
| 4 cron | — | `ops/cli/cron*`, `ops/lib/cron/`, `ops/scripts/cron-run.sh` (mixed in ops/) |
| cross-cutting | `bin/ka`, `ops/cli/common.sh`, `help.sh`, `doctor.sh`, `status.sh` | the ka CLI dispatcher + shared helpers stay shared |

**Reorg principle**: split the `ops/` "one bucket of sh" so workshop / cron /
KB-distill live in part-aligned places, while keeping `common.sh` + the `ka`
dispatcher shared. The TS packages mostly already align (just confirm boundaries
in the doc). The exact target directory names are decided per-part during the
incremental move (see §6).

## 6. Execution plan (gen3 = step 1; gen4 = step 2)

**gen3 (this branch) — design reorg, runtime layout UNCHANGED:**

1. This doc (the contract) → owner review.
2. Reorganize source **one part at a time**, Docker-green after each (the repo
   is always green; nothing big-bang).
3. `install.sh` maps the new source paths onto the **existing** runtime layout
   (`runtime/ops`, `runtime/core-cli`, `runtime/<kind>-daemon`, …) — so the
   deployed/running system is unaffected through the whole reorg.
4. Full verification on the `ka-gen3` branch = **build all packages + ops Docker
   (the case suite) + channel e2e (telegram/lark fakes) + each MCP smoke**, all
   green.
5. `install.sh` → runtime on this Mac → run tests pass.
6. `install.sh` → runtime on the Ubuntu machine → run tests pass.

Because the running runtime keeps the old deployed code until step 5, **the
production system has zero risk for the entire design reorg**.

**gen4 (later) — restructure the runtime layout** into the four parts (changes
`install.sh` deploy paths + how scripts resolve each other). Deferred; out of
scope for gen3.

## 7. Open questions for review

1. Target directory shape for the regrouped `ops/` sh — e.g. keep `ops/` and add
   `ops/workshop/`, `ops/cron/`, `ops/kb/` subdirs, vs promote some to packages?
   (Leaning: subdirs under `ops/` for the sh, since they're host-tooling, not
   shippable TS packages.)
2. Should the KB-distill sh (`distill-bg*.sh`, worker) move next to
   `packages/core` (part 1) or stay in `ops/` under an `ops/kb/`? (Leaning:
   `ops/kb/` — it's orchestration sh around the core CLI, not core TS.)
3. Naming: keep "daemon" or rename Part 3 to "channels" in docs/dirs? (Leaning:
   keep `*-daemon` runtime dirs; use "channels" as the conceptual name in docs.)
