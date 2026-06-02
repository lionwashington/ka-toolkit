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

A pnpm monorepo of independent packages:

| Package | What it does |
|---|---|
| `packages/core` | The knowledge pipeline — capture, distill, retrieval, knowledge-store, daily-log / topic splitters (CJK-aware) |
| `packages/mcp-server` | Knowledge-base MCP server: `kb_search` / `kb_read_topic` / `kb_list_topics` / `kb_status` |
| `packages/channel-core` | Platform-independent MCP-over-HTTP daemon kernel (sessions, routing, dispatch, re-adopt self-heal) |
| `packages/telegram-channel` | Telegram platform adapter for the channel daemon |
| `packages/lark-channel` | Lark (Feishu) platform adapter for the channel daemon |
| `packages/skill`, `packages/skills` | Agent skills: `/kb`, daily-brief, mail, calendar, and more |
| `packages/adapters/claude-code` | Claude Code runtime adapter (capture hook, scheduler, install) |
| `packages/hkprop-mcp` | Hong Kong rental-property search MCP (28Hse + Centanet) |
| `packages/ibkr-mcp` | IBKR position / P&L query MCP |
| `packages/market-mcp` | US-equity / crypto quote MCP |
| `packages/mcp-opennutrition` | Food-nutrition lookup MCP |
| `ops/` | The `ka` CLI (`start` / `stop` / `restart` / `workshop` / `cron`) and supporting libs |

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
  builds and copies the artifacts into `~/.knowledge-assistant/runtime/`; at runtime
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
cd packages/hkprop-mcp && uv run pytest      # Python MCP
```

## Status & scope

This started as a personal tool and is shared as-is. The Claude Code runtime adapter is
the only one implemented; Codex / Gemini CLI are reserved seams. Expect rough edges and
opinions baked in — it is optimized for one person's workflow, not as a turnkey product.

## License

[Apache License 2.0](LICENSE).
