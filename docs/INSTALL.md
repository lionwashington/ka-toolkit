# Knowledge Assistant Installation Guide

[中文版](zh/INSTALL.md)

Set up automatic conversation capture, MCP tools, scheduled jobs, and the
Telegram workshop. This is the single canonical, as-built install guide.

## How install works (design ↔ runtime)

KA keeps a hard boundary between **design** (this repo) and **runtime**
(`~/.knowledge-assistant`, i.e. `KA_HOME`). You build in the repo, then
`./install.sh` copies/bundles the build products into the runtime tree. **The
runtime never depends on the repo** — once deployed, the running `ka`, MCP
servers, hooks, and daemon are self-contained copies, not symlinks back into your
checkout. `KA_HOME` *is* the by-part tree (no `runtime/` wrapper); your live
config + state sit alongside the code in the `config/` and `state/` buckets.

```
clone + build  ──►  ./install.sh  ──►  ~/.knowledge-assistant/   (= KA_HOME)
   (design)          (deploy)            shared/bin/ka, {shared,workshop,
                                         channels,cron,kb}/ops, kb/{core/dist,
                                         mcp,hooks,skills,venvs},
                                         channels/<kind>-daemon
                                         + config/ + state/ (your data)
```

## Prerequisites

- **Claude CLI** (`claude`) — the agent runtime KA drives.
- **Node.js** >= 20 — runs the MCP servers, hooks, and the telegram daemon.
- **pnpm** >= 9 — builds the TypeScript packages.
- **uv** — builds the Python MCP venvs (`hkprop`, `ibkr`). Only needed if you
  use those MCPs.
- **tmux** — the workshop lays out each CC mate in its own pane.

## Step 1: Clone and build

```bash
git clone <repo-url> knowledge-assistant
cd knowledge-assistant
pnpm install
pnpm build
```

`pnpm build` produces the `dist/` outputs that `install.sh` bundles into the
runtime (core CLIs, MCP servers, CC hooks). For the OpenNutrition MCP (native
`better-sqlite3` + bundled dataset) the installer runs its own `npm ci && npm
run build` the first time, so the first deploy of that component is slower.

## Step 2: Deploy to runtime — `./install.sh`

```bash
./install.sh --dry-run     # preview: prints every action, changes nothing
./install.sh               # deploy all components into ~/.knowledge-assistant/ (KA_HOME)
```

Always run `--dry-run` first. A plain `./install.sh` only **deploys** copies
into the runtime tree — it does **not** touch the registrations of anything you
are currently running (your live `~/.claude.json` MCP entries, the running
daemon, cron plists, `~/.claude/settings.json` hooks, skill symlinks). Flipping
those over to the freshly deployed runtime is a separate, explicit `--switch`
step (see Step 6).

### What lands in the runtime

All paths below are relative to `KA_HOME` (`~/.knowledge-assistant`).

| Component | Runtime path | How it's built |
|-----------|--------------|----------------|
| `ka` CLI + ops scripts | `shared/bin/ka`, `{shared,workshop,channels,cron,kb}/ops/` | plain copy (self-locating; no repo dep) |
| Node MCP: kb, market | `kb/mcp/{kb,market}/index.mjs` | esbuild `--bundle` single file |
| Node MCP: opennutrition | `kb/mcp/opennutrition/` | build + copy (native sqlite + dataset) |
| Python MCP: ibkr, hkprop | `kb/venvs/{ibkr,hkprop}/` | `uv build` wheel → install into venv |
| Channel daemons (telegram + lark) | `channels/{telegram,lark}-daemon/` | esbuild `--bundle` + scripts (no secrets) |
| CC hooks (capture/compact) | `kb/hooks/` | esbuild `--bundle` (folds in `@ka/core`) |
| core CLIs (used by `/kb`) | `kb/core/dist/` | plain copy (tsup self-contained) |
| skills (kb, daily-brief, …) | `kb/skills/<name>/SKILL.md` | plain copy |
| config templates + data dirs | `config/` (`*.example.*` templates) + `state/` + `raw/` + `pending-topics/` | seeded, never overwritten |

### Single-component deploys and other flags

```bash
./install.sh --only node-mcp        # redeploy just one component
./install.sh --only daemon --dry-run
```

| Flag | Effect |
|------|--------|
| `--dry-run` | Print every action; change nothing. |
| `--only <component>` | Deploy a single component. Valid: `ka`, `node-mcp`, `python-mcp`, `daemon`, `hooks`, `core-cli`, `skills`, `config`. |
| `--switch` | After deploying, flip live registrations to the runtime (MCP, ka link, cron, hooks, daemon, skills). See Step 6. |
| `--rollback` | Restore the `.pre-switch` backups taken by `--switch`. |
| `--cleanup-old` | After a verified switch, remove the old standalone daemon dir and `.pre-switch` backups (irreversible). |

`KA_HOME=/tmp/ka-itest ./install.sh --dry-run` runs an isolated test against a
temp root, never touching your real runtime.

## Step 3: Put `ka` on your PATH

The deployed CLI is `~/.knowledge-assistant/shared/bin/ka`. Either add its
directory to PATH or symlink it:

```bash
# Option A: symlink into a dir already on PATH
ln -sf ~/.knowledge-assistant/shared/bin/ka ~/.local/bin/ka

# Option B: add to PATH (append to ~/.zshrc or ~/.bashrc)
export PATH="$HOME/.knowledge-assistant/shared/bin:$PATH"
```

(During a `--switch`, `install.sh` also manages the `~/.local/bin/ka` symlink
for you.) Verify:

```bash
ka help
```

## Step 4: Telegram-channel daemon

The daemon is an independent background process that bridges your Telegram DMs
with one or more Claude Code sessions. It holds the bot token at a single exit
point — **CC processes never touch the token**. (This replaces the retired
Claude Code Telegram *plugin*; do not use `/plugin install telegram` or
`/telegram:configure`.)

The deployed daemon code lives at `~/.knowledge-assistant/channels/telegram-daemon/`,
but it holds **no config or secrets of its own** — it reads them from the shared
`config/` bucket: the port (and polling tuning) from `config/config.yaml`
(`channels.telegram.port`, default `9877`) and the token + owner id from
`config/secrets.yaml` (`channels.telegram.{token,owner_chat_id}`). `install.sh`
never touches those files.

1. Create a bot via [@BotFather](https://t.me/BotFather) and note the token.

2. Find your numeric Telegram user id (e.g. DM [@userinfobot](https://t.me/userinfobot)).

3. Configure secrets. Add the `channels.telegram` block to
   `~/.knowledge-assistant/config/secrets.yaml` (create it from the template if it
   doesn't exist — see [Service credentials](#service-credentials-optional)),
   `chmod 600`:

```yaml
# ~/.knowledge-assistant/config/secrets.yaml
channels:
  telegram:
    token: "<your bot token>"               # from @BotFather
    owner_chat_id: "<your numeric telegram user id>"   # only this user may reach the daemon
```

   The port is non-secret and lives in `config/config.yaml` under
   `channels.telegram.port` (default `9877`); edit it there only to change the
   port. The daemon **fails closed** — an empty/missing token or owner id means it
   will not start (run `ka doctor` to surface a misconfiguration).

4. The daemon is normally started for you by `ka workshop` (Step 5). To run it
   standalone:

```bash
~/.knowledge-assistant/channels/telegram-daemon/start.sh    # idempotent
~/.knowledge-assistant/channels/telegram-daemon/status.sh   # health check
curl -s 127.0.0.1:9877/api/status | python3 -m json.tool
```

**Security:** only messages from `owner_chat_id` are processed; the `reply` tool
always sends back to the owner (a compromised CC can't redirect it); `secrets.yaml`
should be `chmod 600` and is gitignored. CC processes never see the token.

## Step 5: First launch — `ka workshop`

```bash
ka workshop                 # bring the workshop up (split-pane layout)
ka workshop --window        # one tmux window per CC instead of panes
ka workshop --dry-run       # preview the layout without launching
```

`ka workshop` starts every mate declared with `default: true` in
`~/.knowledge-assistant/config/workshop.yaml` (seeded from
`config/workshop.example.yaml` on first install — edit it to declare your
panes/cwds), each as an independent
`claude` process in its own tmux pane + cwd, and ensures the telegram daemon is
running. Route to a mate from Telegram with `to <name>: <message>`.

Useful verbs:

```bash
ka workshop start <name>           # start one declared mate
ka workshop stop  <name>           # stop one pane (no name = whole workshop)
ka workshop spawn-mates <name> <workdir>   # register a new mate + launch it
ka workshop restart                # restart the whole workshop (no name = all)
```

## Step 6 (optional): Switch live registrations to the runtime

On a fresh machine you can register the runtime directly. On a machine that's
already running an older deploy, `--switch` flips your live registrations over
to the newly deployed runtime, backing up each target first:

```bash
./install.sh --switch --dry-run    # preview the switch
./install.sh --switch              # rewire MCP / ka link / cron / hooks / daemon / skills
```

`--switch` rewires `~/.claude.json` MCP entries to `$KA_HOME/kb/mcp/*`, points the
`ka` symlink at `$KA_HOME/shared/bin/ka`, repoints cron plists and CC hook paths at
the runtime, migrates any legacy daemon `state.json` into
`$KA_HOME/channels/<kind>-daemon/` and restarts the active daemon, and symlinks
`~/.claude/skills/<name>/SKILL.md` at the runtime copies. (Daemon **secrets** are
not migrated automatically — populate `config/secrets.yaml channels.<kind>` first.)
Each step leaves a `.pre-switch` backup. If anything looks wrong:

```bash
./install.sh --rollback            # restore the backups
```

After verifying the switch is healthy, optionally reclaim the old layout:

```bash
./install.sh --cleanup-old         # remove old daemon dir + .pre-switch backups (irreversible)
```

## Step 7: Scheduled jobs — `ka cron install`

KA's cron jobs (e.g. `kb-distill`, `daily-brief`) are declared in
`~/.knowledge-assistant/config/cron.yaml` and materialized into OS-level
launchd/cron units. After editing the yaml (or to fix drift), sync them:

```bash
ka cron install --dry-run     # preview the OS units that will be created
ka cron install               # idempotent sync: yaml → OS units
ka cron list                  # show jobs with schedule / last-run / status
```

Other subcommands: `ka cron add --name N --schedule S --kind K --command C`,
`ka cron disable <name>`, `ka cron run <name>` (foreground, for debugging),
`ka cron uninstall` (remove OS units, keep yaml), `ka cron import` (pull in
legacy `com.knowledge-assistant.ka.{kb-distill,daily-brief}` plists). See
`docs/KA_CRON_DESIGN.md` for the full design.

## Step 8: Verify

```bash
ka status        # <1s health summary: tmux / telegram daemon / mates / cron
ka doctor        # deeper diagnostics + fix hints; exit 1 if issues found
```

`ka doctor` checks daemon health, channel uniqueness, pane cwds, mate liveness,
and cron consistency. Then, inside a Claude Code session:

```
/kb status       # knowledge base path, topic count, pending items
/kb topics       # list topics (empty on first install)
```

## Google Suite (Gmail + Calendar)

The `/mail` and `/calendar` skills use [gogcli](https://github.com/steipete/gogcli)
to access Google Workspace.

```bash
brew install gogcli
gog auth credentials set /path/to/client_secret.json   # Desktop-app client JSON from Google Cloud Console
gog auth add your@gmail.com                            # opens browser OAuth; repeat per account
gog auth list                                          # verify
```

If you get "missing client_id/client_secret", flatten the JSON — move the
contents of the `installed` key to the top level. Configure which accounts serve
mail vs calendar in `memory/topics/tools.md`.

| Command | Description |
|---------|-------------|
| `/mail` or `/mail check` | Check unread email across accounts |
| `/mail search <query>` | Search emails |
| `/mail send <to> <subject>` | Send email (confirms first) |
| `/calendar` / `/calendar week` | Today's / this week's events |
| `/calendar add <title> <time>` | Create event (confirms first) |

## Service credentials (optional)

Some MCPs need keys/credentials. They live in
`~/.knowledge-assistant/config/secrets.yaml` (gitignored — never commit):

```bash
cp config/secrets.example.yaml ~/.knowledge-assistant/config/secrets.yaml
```

```yaml
amap_api_key: your_amap_api_key   # https://lbs.amap.com/  (weather/maps/navigation)
coros:                            # fitness tracker sync
  email: your@email.com
  password: your_password
```

If a key is missing, the corresponding feature is skipped.

## MCP tools (registered by KA)

| MCP | Tools | Auth |
|-----|-------|------|
| knowledge-assistant | `kb_search`, `kb_read_topic`, `kb_list_topics`, `kb_status` | none |
| market-data | `crypto_price(s)`, `stock_quote(s)` (CoinGecko / Yahoo) | none |
| opennutrition | `search-food-by-name`, `get-food-by-id`, `get-foods`, `get-food-by-ean13` | none |
| hkprop | `search_listings`, `get_listing_detail`, `list_districts`, `agent_contact`, `commute_to_school` | none (Python venv) |
| ibkr | `portfolio_positions`, `portfolio_pnl`, `stock_quote(s)`, `historical_*` | IBKR Gateway |
| amap | weather / geocode / navigation / POI | `amap_api_key` |

Shopping (`/taobao-native` via the Taobao Desktop app, `/jd` via Playwright) and
entertainment (Douban) skills/MCPs are also available; see their skill files for
specifics.

## /kb commands and the data pipeline

| Command | Description |
|---------|-------------|
| `/kb distill` | Capture this session's transcript, then distill all unprocessed `raw/` files |
| `/kb search <query>` | Search the knowledge base |
| `/kb topics` / `/kb read <topic>` | List / read topics |
| `/kb status` / `/kb config` | KB status / current config |
| `/kb pause` / `/kb resume` | Pause / resume capture (persists across sessions) |
| `/kb suggest-topic` / `/kb approve-topic <name>` | Review / approve suggested topics |

Triggers feeding the pipeline:

| Trigger | What it does |
|---------|--------------|
| `/kb distill` (manual) | Capture current session to `raw/`, then process unprocessed `raw/` into `conversations/` + `topics/` + `INDEX.md` + RAG index |
| `kb-distill` cron | Same as manual — runs on schedule if there's unprocessed content |
| Stop hook (session end) | `kb/hooks` script writes the raw transcript to `raw/`, deduped by `session_id` |
| PostCompact hook | Writes raw transcript to `raw/`, then triggers distill |

The LLM is the distillation engine — no external API calls. The knowledge base
is plain Markdown, Obsidian-compatible, git-friendly, and portable.

### Knowledge base layout

```
workspace_path/               # parent of knowledge_base_path
├── SOUL.md  USER.md  IDENTITY.md  AGENTS.md

memory/ = knowledge_base_path/    # ~/knowledge-base/ by default
├── INDEX.md                  # auto-synced topic index
├── raw/                      # raw transcripts (Stop/PostCompact hooks)
├── conversations/            # daily summaries (distill output)
├── topics/                   # distilled knowledge with frontmatter
├── pending-topics/           # topic suggestions awaiting approval
└── .vectors/                 # RAG index (auto-generated)
```

## Custom config (optional)

All settings have defaults — you do **not** need a config file to start. To
customize, copy and edit:

```bash
cp config/config.example.yaml ~/.knowledge-assistant/config/config.yaml
```

| Setting | Default |
|---------|---------|
| `knowledge_base_path` | `~/knowledge-base/` |
| `workspace_path` | parent of `knowledge_base_path` |
| State directory | `~/.knowledge-assistant/state` |
| Secrets file | `~/.knowledge-assistant/config/secrets.yaml` |
| Distill interval | `2h` |
| Max search results / min score | 5 / 0.7 |

## Migrating to a new machine

1. `git clone <repo> && cd knowledge-assistant && pnpm install && pnpm build`
2. `./install.sh --dry-run` then `./install.sh`
3. Put `ka` on PATH (Step 3)
4. Bring these from the old machine:
   - `~/.knowledge-assistant/config/secrets.yaml` (API keys + `channels.<kind>` daemon token/owner)
   - `~/.knowledge-assistant/config/cron.yaml` and `config/workshop.yaml`
   - Knowledge base repo (`git clone`)
   - Google OAuth credentials (`~/Library/Application Support/gogcli/`)
5. `ka workshop` → `ka cron install` → `ka doctor`
6. `brew install gogcli && gog auth add your@gmail.com` for `/mail` and `/calendar`

## Testing

```bash
pnpm test                                   # unit tests across all packages
cd kb/tools/hkprop-mcp && uv run pytest      # hkprop MCP tests
```
