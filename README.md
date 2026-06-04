# ka-toolkit

A **local-first personal knowledge-assistant toolkit** built on top of an agent
runtime (Claude Code today). It captures your LLM conversations, distills them into
an Obsidian-compatible Markdown knowledge base, and ships a set of MCP servers and a
chat-channel daemon so you can drive agent sessions from Telegram or Lark.

> **Design principle — local-first & runtime-agnostic.** Your knowledge base is plain
> Markdown on your own disk. The toolkit is hosted *on* an agent runtime (CC / Codex /
> Gemini CLI) rather than replacing it, reuses your existing subscriptions, and never
> trades local data sovereignty for a cloud service.

---

## What's in here

A pnpm + sh monorepo, organized by **four functional parts** (capability /
orchestration / communication / scheduling) plus shared / config / tests:

| Path | Part — what it does |
|---|---|
| `kb/core` | **Capability.** The knowledge pipeline: capture, distill, retrieval, knowledge-store, daily-log / topic splitters (CJK-aware) |
| `kb/mcp-server` | KB MCP server: `kb_search` / `kb_read_topic` / `kb_list_topics` / `kb_status` |
| `kb/skill`, `kb/skills` | Agent skills: `/kb`, daily-brief, mail, calendar, and more |
| `kb/tools/*` | Domain MCP servers: `hkprop-mcp` (HK rentals · 28Hse + Centanet), `ibkr-mcp` (IBKR P&L), `market-mcp` (equity/crypto quotes), `mcp-opennutrition` (food lookup) |
| `kb/adapter-cc` | Claude Code runtime adapter (capture hook, scheduler, install) |
| `kb/ops` | Background distill worker scripts |
| `channels/core` | **Communication.** Platform-independent MCP-over-HTTP daemon kernel (sessions, routing, dispatch, re-adopt self-heal) |
| `channels/telegram`, `channels/lark` | Telegram / Lark platform adapters; `channels/ops/daemon.sh` is the `ka daemon` CLI |
| `workshop/ops` | **Orchestration.** `ka workshop` (tmux panes / CCs) + start-pane / wait-ready / tmux & yaml helpers |
| `cron/ops` | **Scheduling.** `ka cron` + the run / plist / crontab backend |
| `shared/ops`, `shared/bin/ka` | Cross-cutting: the `ka` dispatcher + `common.sh` / `doctor` / `status` / `help` |
| `config/`, `tests/` | Bundled config templates; the Docker test harness |

## How it fits together

- **Capture → distill → KB.** Conversations are captured and distilled into
  `~/.knowledge-assistant/` as Obsidian-compatible Markdown (daily logs auto-split when
  they grow past a threshold; topics get hub + sub-topic files).
- **MCP servers** expose the KB and the domain tools to any MCP-capable agent.
- **Channel daemon** (`channel-core` + a platform adapter) runs as a standalone
  MCP-over-HTTP service. Each agent session connects to it, so you can send a message
  in Telegram / a Lark group and the corresponding session receives it and can reply.
- **`ka workshop`** brings up multiple agent sessions, each in its own tmux pane / cwd /
  channel, all bound to the daemon.
- **Design / runtime separation.** This repo is pure design-time source. `install.sh`
  builds and copies the artifacts into `~/.knowledge-assistant/`; at runtime
  everything runs the deployed copy and never points back at the repo.

## Getting started

```bash
pnpm install
pnpm rebuild esbuild   # pnpm 10+ gates native build scripts; daemon/MCP bundling needs esbuild
pnpm build
```

- **macOS install:** see [`docs/INSTALL.md`](docs/INSTALL.md)
- **Ubuntu / WSL2 with a Lark daemon:** see [`docs/INSTALL_UBUNTU.md`](docs/INSTALL_UBUNTU.md)
- **Architecture overview:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **`ka` CLI usage:** [`docs/KA_CLI_USAGE.md`](docs/KA_CLI_USAGE.md)

Configuration and secrets live in `~/.knowledge-assistant/` (e.g. `config.yaml`,
`secrets.yaml`) and are never committed — see `config/secrets.example.yaml` for the shape.

## Tests

```bash
pnpm test                                   # JS/TS packages
cd kb/tools/hkprop-mcp && uv run pytest      # Python MCP
```

## Status & scope

This started as a personal tool and is shared as-is. The Claude Code runtime adapter is
the only one implemented; Codex / Gemini CLI are reserved seams. Expect rough edges and
opinions baked in — it is optimized for one person's workflow, not as a turnkey product.

## License

[Apache License 2.0](LICENSE).
