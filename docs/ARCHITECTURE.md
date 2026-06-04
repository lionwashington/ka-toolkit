# Knowledge Assistant Architecture Overview (v3.1 · ka-gen3 as-built)

> **This document is KA's canonical architecture overview.** The four-layer model, the daemon + workshop
> pillars, and the five design principles are unchanged since ka-gen2 (2026-05-31); the paths and the
> deployed runtime layout below reflect the **ka-gen3 reorganization** (source organized by the four
> functional parts; runtime is a single root with no `runtime/` wrapper — see §1.5).
> It no longer describes any retired legacy paths. If it conflicts with the code, the code wins (ground truth: top-level `install.sh`,
> `workshop/ops/workshop.sh`, `shared/bin/ka`, `docs/telegram-channel-design.md`).
>
> **The two pillars of ka-gen2**:
> - **Startup converges onto `ka workshop` + the telegram-channel daemon**: a mate = its own independent CC process
>   (independent tmux pane + independent cwd + independent channel), and it **does not use CC's team-mate mechanism**.
> - **Thorough design / runtime separation**: the repo is pure design-time source; `install.sh` copies the build products into
>   `~/.knowledge-assistant/` (the single runtime root, `KA_HOME`), and at runtime everything runs the deployed copy — **never pointing back at the repo**.
>
> **Retired (no longer covered here)**: the CC team-mate spawn five-condition check / `--teammate-mode` /
> `~/.claude/teams/`, the telegram CC plugin + flock patch + `ops/patches/` + `ops/bootstrap.sh`,
> the mate-auto-approve hook, and never-shipped commands like `ka logs` / `ka mate` / `ka patch-apply`.

---

## §0 Mindset: the Agent itself vs the KA tool set vs runtime vs host

Four kinds of things must be kept distinct:

- **Agent = KB + PA** is the **portable core**, depending on no tool.
- **KA** is an **application-layer tool set** that runs hosted on the agent runtime, helping the Agent continuously form and refine itself.
- **agent runtime** (Claude Code / Codex / Gemini CLI) is the **execution environment** that KA relies on to run (replaceable).
- **host facilities** (tmux / launchd / macOS) are the **concrete backend implementations** on this machine (replaceable).

### Key term: agent runtime

**agent runtime** (**runtime** for short) = the underlying CLI / IDE that provides the agent's execution environment.

| runtime | Vendor / project | Current KA support |
|---|---|---|
| **Claude Code** (CC) | Anthropic | ✅ primary (the only one actually implemented) |
| **Codex** | OpenAI | 🔜 reserved name, deferred |
| **Gemini CLI** | Google | 🔜 reserved name, deferred |

ka-gen2 decision: **runtime keeps only `cc`**, retaining the adapter boundary; codex / gemini get no directory and no investment for now.

Core thesis: **your workspace is itself a complete, portable Agent that depends on no tool.** KA is its
application-layer tool set and **does not usurp runtime responsibilities** (CC's team mechanism, plugin system, MCP protocol, etc. are all out of KA's scope).

---

## §1 The four-layer model

```
   ┌─────────────────────────────────────────┐
   │  Agent  =  KB  +  PA                    │  ← portable core (your workspace)
   └─────────────────────────────────────────┘
                      ▲  forms / refines
                      │
   ┌─────────────────────────────────────────┐
   │  KA tool system                         │  ← application layer (this repo)
   │  workshop · distill · brief · shopping  │
   │  mail · calendar · market-data · MCP    │
   └─────────────────────────────────────────┘
                      ▲  hosted on
                      │
   ┌─────────────────────────────────────────┐
   │  agent runtime                          │  ← execution environment (replaceable)
   │  Claude Code (current) | Codex | Gemini │
   └─────────────────────────────────────────┘
                      ▲  runs on
                      │
   ┌─────────────────────────────────────────┐
   │  host OS + system services              │  ← physical infrastructure
   │  tmux · launchd · macOS                 │
   └─────────────────────────────────────────┘
```

**How to read it**: bottom-up — the host carries the runtime; the runtime carries KA; KA continuously forms and refines
the top-level Agent (KB + PA) as it runs.

### §1.1 Inside the Agent: KB + PA

```
                  Agent
                ╱       ╲
              KB         PA
         Knowledge    Personal
           Base        Agent
                  (soul protocol)
```

- **PA (Personal Agent)**: `<your-workspace>/*.md` — the persona and soul protocol
  - `SOUL.md` ("who you are") / `USER.md` ("who you're helping") / `IDENTITY.md` ("who you're playing right now")
  - `AGENTS.md` / `memory/topics/rules.md` (operating rules)
- **KB (Knowledge Base)**: `<your-workspace>/memory/` — an Obsidian-compatible Markdown knowledge base
  - `topics/*.md` (distilled topics) / `conversations/YYYY-MM-DD.md` (daily conversation log) / `INDEX.md` (topic routing)

**The workspace repo = the container of the PA, and it contains the KB**; the whole repo is the "mental entity" of a complete Agent:
clone it on a different machine, load it with a different CLI, and the same Agent lives on.

### Portability

| Replace this | Does the Agent still live? |
|---|---|
| Claude Code → Gemini CLI / a custom runtime | ✅ as long as the new runtime can read Markdown + run a shell |
| tmux → another pane manager | ✅ backend implementation detail |
| telegram → slack / discord | ✅ the channel is a replaceable backend |
| **Remove KA entirely** | ✅ the Agent is still there, it just loses the "limbs" like workshop / distill / brief |
| **Change the internal structure of the workspace** | ❌ this is the Agent itself |

**Conclusion**: KB + PA are the architectural foundation; KA / CC / tmux are all replaceable periphery.

---

## §1.5 The four functional parts (the KA layer, decomposed)

§1 stacks four *layers* (Agent / KA / runtime / host) — "what runs on what". A
second, orthogonal cut decomposes **the one KA layer itself** into four functional
**parts**, each a distinct concern. This is the axis the whole repo (and the
deployed runtime) is organized by since gen3.

| # | Part | Concern | One-line role | Code |
|---|------|---------|---------------|------|
| 1 | **KB + capability** | capability | give a *single* agent runtime more ability | `kb/` |
| 2 | **workshop** | orchestration | manage *many* co-located runtimes | `workshop/` |
| 3 | **channels** (daemon) | communication | message in/out + runtime↔runtime | `channels/` |
| 4 | **cron** | scheduling | fire things on a schedule | `cron/` |

- **Part 1 — KB + capability**: everything that makes *one* runtime more capable —
  kb core (`kb/core`: capture→distill→deposit→query), kb MCP server
  (`kb/mcp-server`), skills (`kb/skill`, `kb/skills`), domain MCP tool servers
  (`kb/tools/*`). Consumed by a runtime; it does not orchestrate / message / schedule.
- **Part 2 — workshop**: brings up and manages *multiple* runtime processes, each in
  its own tmux pane + cwd (`workshop/ops/*`), plus the tmux-native collaboration mode
  (capture-pane / send-keys). Owns processes + panes; not the messaging channel.
- **Part 3 — channels / daemon**: a single long-lived channel daemon (telegram or
  lark) over MCP-over-HTTP — external IM↔runtime (`reply`) + runtime↔runtime
  (`send_to_channel` cc2cc). `channels/core` (kernel) + `channels/{telegram,lark}`
  (platform adapters). Owns message transport only.
- **Part 4 — cron**: declarative OS-level scheduling (`cron/ops/*` → launchd/crontab).
  Cross-cutting — owns *when*, not *what*; the jobs it fires belong to Parts 1/3.

```
   Part 4 cron ──fires──▶ Part 1 (distill/brief) · Part 3 (daemon self-heal)
   Part 2 workshop ──messages via──▶ Part 3 channels (cc2cc / owner reply)
   Part 1 capability ◀──called by── the agent runtime (each pane is a runtime)
```

The `ka` CLI (`shared/bin/ka`) is cross-cutting, not a fifth part — its verbs map
onto the parts (`ka workshop`→2, `ka daemon`→3, `ka cron`→4, `ka distill`→1).

### Repo / runtime structure (organized by the four parts)

Every top-level dir is one of: a **part** (`kb`/`workshop`/`channels`/`cron`), the
**shared** cross-cutting bucket, **config** (all templates), or **tests**. The
deployed runtime mirrors this directly under `KA_HOME` (no `runtime/` wrapper; see §4).

```
ka-toolkit/
├── kb/             Part 1 — KB + capability
│   ├── core/             capture · distill · retrieval · knowledge-store      (TS)
│   ├── mcp-server/       kb_search / kb_read_topic / kb_list_topics / kb_status (TS)
│   ├── skill/  skills/   /kb + daily-brief · mail · calendar · jd · …
│   ├── tools/            domain MCP servers: hkprop · ibkr · market · nutrition (TS/py)
│   ├── adapter-cc/       cc capture-hook + install                            (TS)
│   └── ops/              distill-bg.sh · distill-bg-worker.sh · distill-status.sh
├── workshop/       Part 2 — orchestration (sh only)
│   └── ops/              workshop.sh · start-pane.sh · tmux-helpers.sh · yaml-parse.sh ·
│                         inject-prompt.sh · wait-ready.sh · runtimes/cc · panes/
├── channels/       Part 3 — communication (the daemon)
│   ├── core/             channel-core kernel: routing · dispatch · sessions · http (TS)
│   ├── telegram/         telegram platform adapter                            (TS)
│   └── lark/             lark platform adapter                                (TS)
├── cron/           Part 4 — scheduling (sh only)
│   └── ops/              cron.sh · cron-run.sh · cmd/ · internals/ · maintenance/
├── shared/         cross-cutting (spans all parts — not a part itself)
│   ├── bin/ka            the dispatcher (routes `ka workshop|daemon|cron|distill|…`)
│   └── ops/              common.sh (the one directory map) · doctor.sh · status.sh · help.sh
├── config/         ALL config templates (yaml only — full-B dropped per-daemon json)
│   └── config.example.yaml · secrets.example.yaml · workshop.example.yaml
├── tests/          cross-cutting test infrastructure (the Docker harness + cases)
└── docs/  ·  install.sh  ·  pnpm-workspace.yaml  ·  package.json  ·  tsconfig.base.json
```

---

## §2 kb core (the knowledge-base core, unchanged)

kb core is KA's most central, runtime-agnostic capability: it takes raw LLM conversations and **captures → distills →
deposits → queries** them into an Obsidian-compatible Markdown knowledge base owned by the user. This part has been unchanged since ka-gen2.

| Subsystem | Source | Responsibility |
|---|---|---|
| **capture** | `kb/core/src/` + the CC capture-hook | Write the session transcript into `~/.knowledge-assistant/raw/` |
| **distiller** | `kb/core/src/` | Distill `raw/` into `memory/topics/*.md` (user memory / skills / log / topic suggestions) |
| **knowledge-store** | `kb/core/src/` | KB read/write + Obsidian-compatible markdown + INDEX routing |
| **retrieval / watermark** | `kb/core/src/` | CJK-tokenized retrieval + incremental watermark (never reprocesses already-distilled raw) |
| **kb MCP server** | `kb/mcp-server/` | Expose `kb_search / kb_read_topic / kb_list_topics / kb_status` to any MCP client |
| **/kb skill** | `kb/skill/src/kb.md` | Skill entry point for browsing / searching / triggering distillation / reviewing topic suggestions |

**Distillation triggers**: ① `/kb distill` (foreground, inside the skill) ② `ka distill` (background)
③ `ka cron` scheduled (every 2h by default). All three share the same distiller pipeline.

**Key property**: KB content is **owned by the user** (local Markdown, can be git-tracked, opens directly in Obsidian),
and is a completely different thing from CC's `/recap` / away-summary — the latter are temporary in-session context, while
KA distill is a persistent cross-session knowledge base.

---

## §3 runtime model: daemon + workshop (independent CC processes)

ka-gen2 converges "multi-agent collaboration + external channel" into two pillars: the **telegram-channel daemon** handles
the outward channel, and **`ka workshop`** orchestrates a set of independent CC processes. **There is no longer any CC team-mate mechanism.**

### §3.1 telegram-channel daemon (the single channel exit)

For implementation-level details see `docs/telegram-channel-design.md`. Key points:

- **A standalone background daemon**: node + express, bound to `127.0.0.1:9877`, **MCP-over-HTTP**
  (`/mcp` SSE), **not a CC plugin and not relying on flock**. Singleton via port binding (`EADDRINUSE → exit 0`).
- **The token lives only in the daemon**: the daemon holds the bot token exclusively to do `getUpdates` long-polling; **CC processes never touch the
  token**, they only send/receive via MCP tools (`reply` / `send_to_channel`) — a single credential exit.
- **Multi-channel routing**: in Telegram the user routes to a target channel with a `to <name|number>:` prefix
  (no prefix → `main`); each CC process is attached to a channel name (registration URL `?name=<X>`).
- **CC↔CC communication**: via `send_to_channel` (cc2cc, see `docs/telegram-channel-design.md` §5),
  distinct from `reply` which goes to the user.
- **M6 half-open self-healing (2026-05-31)**: a standard MCP `ping` probe detects a half-open SSE (network jitter / sleep-wake
  causes the daemon's `send()` to silently no-op) → `closeStandaloneSSEStream()` closes the stream to preserve the session, lets the CC
  seamlessly reconnect with the **same session-id** via SSE retry; only a truly dead one (>60s unreachable) gets evicted. This both cures the half-open deadlock
  and avoids leaking zombie sessions.
- **Supervision**: the `* * * * * start.sh` installed by `ka cron` self-heals (brings it back up within ≤60s if it dies). To upgrade the daemon code,
  `./install.sh --only daemon` then `ka daemon restart` (every CC re-adopts automatically).

### §3.2 ka workshop (orchestrating independent CC processes)

`ka workshop` is the **only** startup/orchestration entry point (`ka start` / `ka stop` / `ka spawn-mates` all
forward to it). Ground truth: `workshop/ops/workshop.sh`.

```
workshop.yaml ──read──▶ ka workshop ──ensure──▶ telegram-channel daemon (:9877)
                            │
                            └─ for each mate: tmux brings up a pane/window
                               · independent cwd (-c)
                               · independent channel (KA_CHANNEL → registration URL ?name=<name>)
                               · independent claude process (--dangerously-load-development-channels
                                                  server:telegram-channel)
```

Core abstractions:

- **mate = an independent CC process**: independent tmux pane + independent cwd + independent channel. Process isolation —
  one dying doesn't affect the others; the user can eyeball a pane and manually attach to intervene. **This is not CC's in-process subagent.**
- **main pane = the CC of the `main` channel**: the primary interaction point; the user's unprefixed messages route here by default.
- **layout is a purely visual choice**: `--pane` (default, all CCs split into one window) or `--window`
  (one CC per window). cwd / context are **never shared**.
- **The dev-channels safety gate passes automatically, condition-based**: after a pane starts, poll `capture-pane`, and only send Enter once
  the gate's text `Enter to confirm` is detected (not a timed blind send; skipped after a ~18s timeout).

workshop verbs (`workshop/ops/workshop.sh`):

| Verb | Behavior |
|---|---|
| `ka workshop [--pane\|--window]` | bare = start all mates with `default=true` (= `start` with no name) |
| `ka workshop start [<name>]` | no name → start all; with a name → pure launcher (starts it if in the yaml, reports missing if not; never registers a new mate) |
| `ka workshop stop [<name>]` | no name → stop the whole session; with a name → stop only that pane |
| `ka workshop restart <name>` | restart a single mate's pane (⚠️ loses that CC's runtime context; don't use it merely to reconnect a dropped channel — triggering one tool call is enough to re-init) |
| `ka workshop spawn-mates <name> [<workdir>]` | with a workdir = registrar (write/replace yaml + start); without = alias for `start <name>` |

**workshop.yaml** (declarative layout; `config/workshop.example.yaml` is the template, seeded on install to
`~/.knowledge-assistant/config/workshop.yaml`): each pane declares `name` / `cwd` / `runtime` (default `cc`) /
whether it is `default`.

### §3.3 The ka CLI command surface (the ones that actually exist)

`shared/bin/ka` forwards to each part's `*/ops/*.sh`. The commands that **actually exist**:

| Command | Description |
|---|---|
| `ka workshop [start\|stop\|restart\|spawn-mates] [name]` | workshop lifecycle / tmux panes (see §3.2); restart with no name = whole workshop |
| `ka daemon [start\|stop\|restart\|status\|config]` | the active channel daemon (kind from `config.yaml channel_kind`) |
| `ka status` | <1s health summary (config / session / daemon / channels / cron) |
| `ka doctor` | deeper read-only consistency diagnostics + fix hints |
| `ka cron` | declarative scheduled jobs (see §5) |
| `ka distill [status]` | trigger background distillation / show its progress (foreground is inside `/kb distill`) |

> The `ka logs` / `ka mate` / `ka patch-apply` / `ka install-crons` that were planned in old docs but **never shipped**
> do not exist and have been removed from this document.

---

## §4 The design / runtime separation boundary

> This section is the authoritative definition of the design/runtime boundary (the decision was finalized 2026-05-29).

### §4.1 Principles

- **Design-time = the repo**: the repo root, pure source, tracked in git, distributable.
- **Runtime = the deployment/state under `~/`**: not in git, per-machine.
- **`install.sh` = the bridge between them**: build (design-time) → copy to the runtime location → at runtime only the deployed
  products run, **never the repo directly**.
- The only reasonable exception: **platform-mandated locations** (CC skills must be in `~/.claude/skills/`, launchd plists
  must be in `~/Library/LaunchAgents/`) — respect the platform, but it's still a "post-deploy product," not a symlink to the repo.

### §4.2 The runtime belongs to two users (key)

The runtime isn't one lump; it's **two big blocks belonging to different owners**:

- **ka's runtime** = `~/.knowledge-assistant/` (= `KA_HOME`, the single runtime root) — **owned by ka**: the ka
  products deployed by-part directly under it (`shared/bin/ka`, `shared/ops`, `kb/{core/dist,mcp,hooks,skills,venvs}`,
  `channels/<kind>-daemon`, `workshop/ops`, `cron/ops`) + the two data buckets `config/` and `state/`. There is **no
  `runtime/` wrapper** — `KA_HOME` *is* the by-part tree (mirrors the repo layout; leaves are compiled bundles / venvs).
- **cc's runtime** = `~/.claude/` — **owned by Claude Code**: `settings.json` / `skills/` /
  `.claude.json`, etc. ka **never mixes its own things into cc's root**; it only "follows the host's lead" and places what belongs there per the CC interface
  (symlink skills into `~/.claude/skills/`, write MCP registrations into `~/.claude.json`).

> Mnemonic: almost everything prefixed `~/.claude/` belongs to CC; only what's prefixed `~/.knowledge-assistant/` belongs to KA.

### §4.3 Design → runtime mapping (what install.sh lands)

| Component | Design-time (repo) | Runtime (deployed product, under `$KA_HOME`) | Deploy method |
|---|---|---|---|
| `ka` CLI + ops | `shared/bin/ka` + `*/ops/` | `shared/bin/ka` + `{shared,workshop,channels,cron,kb}/ops/` (copy, **not symlink**) | copy |
| node MCP (kb / market) | `kb/mcp-server`, `kb/tools/market-mcp` | `kb/mcp/<name>/index.mjs` (self-contained esbuild bundle) | esbuild |
| node MCP (opennutrition) | `kb/tools/mcp-opennutrition` | `kb/mcp/opennutrition/` (native sqlite, copied whole) | build + copy |
| python MCP (ibkr / hkprop) | `kb/tools/*` | `kb/venvs/<name>` (**wheel install, not editable**) | build wheel + pip |
| CC hooks (capture / compact) | `kb/adapter-cc/dist/hooks` | `kb/hooks/` (esbuild bundle, @ka/core folded in self-contained) | esbuild |
| core CLI (called by the kb skill) | `kb/core/dist/*-cli.js` | `kb/core/dist/` (tsup already self-contained, pure copy) | copy |
| skills (5 + kb) | `kb/skills/*.md` + `kb/skill/src/kb.md` | `kb/skills/<name>/SKILL.md`; `~/.claude/skills/<name>` symlink pointing at runtime | copy + symlink |
| telegram daemon | `channels/telegram` | `channels/telegram-daemon/` (esbuild bundle + scripts; no secrets) | esbuild + copy |
| config / state / credentials | repo ships `config/*.example.{yaml,…}` templates | `$KA_HOME/config/{config,secrets,workshop,cron}.yaml` + `$KA_HOME/state/` + `$KA_HOME/raw/` | install seed (no overwrite) |
| cron plist | `cron/ops/cron` generator | `~/Library/LaunchAgents/com.knowledge-assistant.ka.cron.*.plist` (platform-mandated) | ka cron install |

### §4.4 install.sh safety red lines

- By default it operates on `~/.knowledge-assistant`, but provides a `KA_HOME` override (pointing at a temp dir) for isolated testing.
- The steps that actually "switch the live runtime" (rewriting `~/.claude.json` MCP registrations, moving the daemon, changing hook paths, creating skill
  symlinks) are **SKIPPED by default**; they require an explicit `--switch` and must be run by the user — a plain install **never touches** the running
  `~/.claude.json` / daemon.
- Each `--switch` step backs up first (`.pre-switch-*`); recovery is a manual restore of those backups (there is no `--rollback` command).
- seed_config never overwrites existing config/credentials.
- A single copy mode (no dev/prod dual mode): apply development changes with incremental redeploys via `./install.sh --only <component>`,
  running `--dry-run` first to confirm it only touches the target component.

> **Hard rule (learned the hard way)**: runtime products **can only be produced by `install.sh`**, never hand-built (no manual esbuild / cp /
> directly editing `$KA_HOME/**`). Fixing runtime behavior is always two steps: ① change `install.sh`
> or the source it bundles (the design side) → ② run `./install.sh --only <component>`. Skipping the second step lets
> design/runtime quietly drift apart.

---

## §5 KA design principles (the five, non-negotiable)

> These five are KA's core doctrine: any strategic suggestion about KA
> (including "should we cede this to CC's native capability" or "should we move to the cloud") **must first pass these five gates**, and anything that fails is flagged immediately.

1. **Local-first**: data, compute, and scheduling all live on the local machine; cloud tools are only an optional supplement.
2. **Runtime agnostic**: KA runs on top of an agent runtime (CC / Codex / Gemini CLI), not bound to any single one.
3. **Reuse subscriptions**: the subscription the user already pays for (e.g. CC Max) is the source of capability; KA charges no extra API fees.
4. **Privacy / data sovereignty**: the KB is local, the PA is local; the user can migrate whenever they want.
5. **No cloud replacing local**: any cloud tool (Routines / cloud automation) should never become a required dependency of KA.

**Worked example**: Claude Code Routines (a cloud SaaS) violates all five (runs in the cloud, hard-bound to Anthropic, separate
quota that doesn't reuse the subscription, data goes to the cloud, pushes the user toward the cloud) → not a migration target or strategic dependency for KA. Likewise,
workshop / distill / OS-level cron / the custom MCP servers, after audit, each still have irreplaceable local value — kept.

---

## §6 Capability inventory

KA's current capabilities. **status**: `shipped` = code delivered; `adapter-only` = KA defines the protocol + adapter,
the capability is provided by the runtime; `planned` = not yet delivered.

| Capability | status | Path | Description |
|---|---|---|---|
| **kb core** | shipped | `kb/core/` + `kb/mcp-server/` + `kb/skill/` | capture / distill / store / retrieve + MCP + /kb skill (§2) |
| **workshop** | shipped | `workshop/ops/workshop.sh` + `workshop/ops/` + `config/workshop.example.yaml` | orchestrate independent CC processes (§3.2) |
| **telegram channel** | shipped | `channels/telegram/` (on `channels/core/`) | MCP-over-HTTP daemon, multi-channel routing + M6 self-healing (§3.1) |
| **distill scheduling** | shipped | `ka cron` + `kb/core/` | OS-level persistent scheduling (distill every 2h by default) |
| **daily brief** | shipped | `kb/skills/daily-brief.md` | daily briefing (triggered by cron at 7:00, delivered to a channel) |
| **shopping** | shipped | `kb/skills/taobao-native/` + `kb/skills/jd.md` | Taobao / JD.com shopping skills |
| **mail** | shipped | `kb/skills/mail.md` | send/receive email (gogcli backend), archive → KB |
| **calendar** | shipped | `kb/skills/calendar.md` | Google Calendar scheduling skill (gogcli backend) |
| **market-data** | shipped | `kb/tools/market-mcp/` | quotes MCP (stock / crypto) |
| **hkprop** | shipped | `kb/tools/hkprop-mcp/` | Hong Kong property MCP (28Hse + Centanet) |
| **ibkr** | shipped | `kb/tools/ibkr-mcp/` | IBKR position / quote query MCP |
| **nutrition** | shipped (experimental) | `kb/tools/mcp-opennutrition/` | OpenNutrition nutrition-database MCP |

Skill-form capabilities are currently delivered as CC skills (markdown / frontmatter); porting them to another runtime requires re-packaging.

---

## §7 Configuration panorama

Three big categories: **the Agent itself** / **KA products (design)** / **per-machine runtime (not in git)**.

### 7.1 The Agent itself (inside your workspace)

| Path | Content |
|---|---|
| `<your-workspace>/SOUL.md` / `USER.md` / `IDENTITY.md` | PA identity |
| `<your-workspace>/memory/INDEX.md` / `topics/*.md` / `conversations/*.md` | the KB body |

### 7.2 KA products (the knowledge-assistant repo, design side, distributable)

| Path | Content |
|---|---|
| `kb/core/` | distiller / config / tokenizer / core CLI |
| `kb/mcp-server/` + `kb/tools/{market-mcp,mcp-opennutrition,hkprop-mcp,ibkr-mcp}` | MCP servers |
| `kb/skills/` + `kb/skill/src/kb.md` | skill sources |
| `channels/core/` + `channels/{telegram,lark}/` | channel daemon kernel + platform adapters |
| `kb/adapter-cc/` | CC capture/compact hook source |
| `shared/bin/ka` + `{shared,workshop,channels,cron,kb}/ops/` | CLI + orchestration + cron generator |
| `install.sh` | unified deployment entry point |
| `docs/` | this document + telegram-channel-design + KA_CLI_USAGE + INSTALL |

### 7.3 per-machine runtime (not tracked by git)

| Path | Content | Owner |
|---|---|---|
| `$KA_HOME/{shared/bin/ka,*/ops,kb/{core/dist,mcp,hooks,skills,venvs},channels/<kind>-daemon}` | KA products deployed by install (by-part, no `runtime/` wrapper) | **KA** |
| `$KA_HOME/config/{config,secrets,cron,workshop}.yaml` | config / credentials / cron / layout (the `config/` data bucket) | **KA (user config)** |
| `$KA_HOME/state/` + `$KA_HOME/{raw,pending-topics}/` | runtime state (the `state/` bucket) + capture/distill data | **KA (runtime state)** |
| `~/Library/LaunchAgents/com.knowledge-assistant.ka.cron.*.plist` | cron (KA generates + loads, launchd executes) | **per-machine config (platform-mandated)** |
| `~/.claude/settings.json` / `.claude.json` / `skills/<name>` | CC harness config / MCP registration / skills symlink | **CC backend; KA only places via the interface** |

> Credentials go in `$KA_HOME/config/secrets.yaml` (KA's native capability) — including the channel daemon's own token
> (`channels.<kind>.token`, which the daemon reads directly; there is no per-daemon `.env` or `config.json` any more).
> CC processes never touch the token.

---

## §8 cron: OS-level persistent scheduling

`ka cron` (`cron/ops/cron.sh`) declares scheduled jobs in `~/.knowledge-assistant/config/cron.yaml`, and
`ka cron install` syncs them into launchd units `com.knowledge-assistant.ka.cron.*`.

- **Positioning**: **OS-level persistent scheduling** — runs as long as the machine is on, and **does not depend on any claude session being online**
  (complementary to, and non-conflicting with, CC's in-session loops like `CronCreate` / `/loop`).
- Subcommands: `list` / `add` / `remove` / `enable` / `disable` / `run` / `install` /
  `uninstall` / `import` / `status`.
- Typical jobs: distill every 2h, daily-brief at 7:00 every day, telegram-daemon self-heal every minute.

---

## §9 Scope of impact when swapping the stack

| Swap out | Need to change | No need to change |
|---|---|---|
| CC → Gemini CLI | the workshop's runtime adapter, the MCP host protocol, re-packaging skills; runtime credentials belong to each | KB + PA (zero change); distill / brief logic; the KA config under `~/.knowledge-assistant/`; the runtime-agnostic `kb/core/`, etc. |
| tmux → another pane manager | the tmux calls in `workshop/ops/workshop.sh` + `workshop/ops/` | the Agent; ka's outward CLI; cron |
| launchd → systemd / cron | the `cron/ops/cron` generator | everything else |
| telegram → slack | rewrite the channel daemon (credentials go through that backend's own mechanism) | the Agent; workshop; ka CLI |
| **Replace the entire KA with a different tool set** | rewrite every capability | **the Agent is fully preserved** |

> **KA ↔ Agent mnemonic**: the runtime gives the Agent the air to breathe; KA grows the Agent's memory, habits, and limbs.
> distill grows the KB, daily-brief wakes the PA's working memory, workshop amplifies the PA into multiple processes,
> mcp-server exposes the KB as structured queries, and the channel extends the Agent onto the phone.

---

*v3.0 (2026-05-31, ka-gen2 as-built) —*
*① Startup model rewritten: CC team-mate spawn → `ka workshop` orchestrating independent CC processes;*
*② Channel rewritten: telegram CC plugin + flock → telegram-channel daemon (MCP-over-HTTP + M6 self-healing);*
*③ Inlined the design/runtime separation boundary + the install.sh landing mapping;*
*④ Inlined the five KA design principles;*
*⑤ Removed never-shipped ka commands, ops/patches, ops/bootstrap.sh, the mate-auto-approve hook;*
*⑥ Aligned the command surface, capability inventory, and configuration panorama with the current code.*
