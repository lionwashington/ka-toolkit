# lark-channel — source + docs bundle

Source-of-truth for the Lark channel daemon. The daemon is the `channels/core` kernel +
`lark-platform.ts` adapter, deployed (via `install.sh --only daemon`) as a single self-contained
`daemon.mjs` esbuild bundle into `~/.knowledge-assistant/channels/lark-daemon/`. Daemon version v0.6.2.

## Contents (channels/lark/)
| File | Description |
|---|---|
| lark-platform.ts | the Lark platform adapter (per-group lark-cli polling, webhook send, self-filter, attachment download), driven by the `channels/core` kernel |
| package.json | dependency manifest (`@modelcontextprotocol/sdk` + `express` + `yaml`) |
| daemon.sh / start.sh / stop.sh / status.sh | lifecycle scripts (deployed alongside the bundle) |
| tests/ | `pnpm test` — unit tests + e2e (fake lark-cli + mock webhook + real MCP client) |
| skill/SKILL.md | Claude Code ops skill |
| ARCHITECTURE.md | architecture design |
| README.md | overview + quickstart + ops |
| SETUP.md | install & end-to-end test walkthrough |
| .gitignore | — |

## Config & secrets (NOT in this dir)
Real config + secrets live in the shared `~/.knowledge-assistant/config/` bucket, not per-daemon:
- `config.yaml` channels.lark — non-secret: `port` (9876) / `poll_interval_seconds` / `page_size` / `lark_cli_bin`
- `secrets.yaml` channels.lark — secret: `self_open_id` + `groups.<chat_id>.{name, webhook_url, poll_interval_seconds}`

Templates: `config/config.example.yaml` + `config/secrets.example.yaml` (commented `channels.lark` block).

## Runtime artifacts (deployed dir, not in git)
`~/.knowledge-assistant/channels/lark-daemon/` additionally holds, after install:
- `daemon.mjs` — the esbuild bundle (channel-core + lark-platform + deps; no `.ts`, no `node_modules`)
- `state.json` — per-group `last_seen_msg_time` watermarks
- `channel.log` / `daemon.stdout.log` / `supervisor.log` — logs
- `daemon.pid` / `.daemon.lock` — singleton/runtime state
- `attachments/` — downloaded inbound attachments

## Deploy & Run
1. `pnpm install` (needed for the esbuild bundle step)
2. `./install.sh --channel-kind=lark --only daemon` → builds `daemon.mjs` + copies scripts into `~/.knowledge-assistant/channels/lark-daemon/`
3. Fill `~/.knowledge-assistant/config/secrets.yaml` channels.lark (`self_open_id` + `groups`) and port/tuning in `config.yaml`
4. `~/.knowledge-assistant/channels/lark-daemon/start.sh` (cron pulls it up every minute as a backstop); `status.sh | jq` to check health
</content>
