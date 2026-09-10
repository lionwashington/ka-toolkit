# Hermes Agent evaluation and KA interoperability

> Evaluation date: 2026-07-23  
> Hermes version: 0.19.0 (`v2026.7.20`, commit `3ef6bbd`)  
> Status: protocol spike passed; no production Hermes process or credentials installed

## Decision

Hermes Agent is a complete agent runtime rather than a KB component. KA should
remain the source of truth for knowledge, personality, and rules. If Hermes is
adopted, start it as an isolated experimental runtime and give it read-only
access to KA through the existing KB MCP endpoint. Do not copy or migrate the
Markdown knowledge base into Hermes.

This preserves the architectural boundary in `docs/ARCHITECTURE.md`: KA is the
application layer above replaceable agent runtimes. It also avoids running two
independent memory writers over the same user data.

## Verified interoperability

Hermes 0.19 supports MCP Streamable HTTP and per-server tool whitelists. The
following isolated configuration connected to KA's loopback KB daemon:

```yaml
mcp_servers:
  ka-kb:
    url: http://127.0.0.1:7705/mcp
    connect_timeout: 10
    timeout: 30
    keepalive_interval: 60
    tools:
      include:
        - kb_search
        - kb_read_topic
        - kb_list_topics
        - kb_status

# Evaluation defaults: propose changes, do not silently mutate learned state.
memory:
  write_approval: true
skills:
  write_approval: true
```

The test used a temporary `HERMES_HOME`, Python 3.13, no model credentials, no
gateway, and no imported memory. Hermes's own `hermes mcp test ka-kb` connected
in 680 ms and discovered exactly four tools.

The same four tools were then registered through Hermes's production MCP tool
registry and dispatched through its normal handler path:

| Hermes tool | Result | Observed latency |
| --- | --- | ---: |
| `mcp__ka_kb__kb_status` | non-empty, no error | 45 ms |
| `mcp__ka_kb__kb_list_topics` | non-empty, no error | 37 ms |
| `mcp__ka_kb__kb_search` (`max_results: 1`) | non-empty, no error | 9.1 s |
| `mcp__ka_kb__kb_read_topic` | non-empty, no error | 40 ms |

No KA runtime configuration was modified. The test did not start a persistent
Hermes process. The temporary checkout and virtual environment are disposable.

## Meaning of "read-only"

The whitelist exposes only KA query tools. It does not expose distill, reindex,
topic mutation, channel delivery, cron, shell, or filesystem tools through this
MCP server. `kb_read_topic` may append KA's internal read metric when frozen
snapshot accounting is enabled, but it does not modify topic content.

The MCP whitelist is not a complete sandbox. Hermes's own built-in terminal,
file, plugins, and skills are separate capabilities. An experimental Hermes
profile must therefore use an OS-isolated backend and a restricted toolset.

## Recommended experiment boundary

1. Give the experiment a dedicated OS user or Docker container and a dedicated
   `HERMES_HOME`.
2. Do not mount KA's memory directory into the container. Reach it only through
   the loopback/private-network KB MCP endpoint.
3. Enable only the four `ka-kb` MCP tools initially. Disable local terminal,
   file mutation, browser, external MCPs, plugins, cron, gateway, and automatic
   skill/memory writes.
4. Use a separate bot token if gateway testing is later authorized. Never share
   the production KA channel token during the first phase.
5. Evaluate with synthetic or low-sensitivity prompts before allowing access to
   the full personal KB.
6. Treat Hermes upgrades as migrations: pin the release, rerun the MCP contract
   test, then promote deliberately.

## Why a Workshop runtime adapter is not the first step

The Workshop adapter contract can launch a TUI, recognize readiness, and inject
prompts, but KA Channel streaming requires a runtime-native event source. Codex
has its App Server and Claude Code has its channel integration. A basic Hermes
tmux adapter would launch a pane but would not provide reliable Telegram
streaming, cancellation, session adoption, or single-owner final delivery.

Before adding `runtime: hermes`, choose and validate one integration transport:

- Hermes API/ACP as a Channel runtime backend; or
- a Hermes plugin that implements the KA Channel protocol; or
- a separate Hermes gateway and bot, intentionally outside KA Channel.

The first two require a real Channel consumer and end-to-end streaming tests.
The third is suitable for an isolated product evaluation but is not a KA Mate.

## Components worth adapting into KA

High-value candidates that do not require adopting Hermes's agent loop:

1. SQLite FTS5 session browse/scroll alongside KA semantic retrieval.
2. Background memory/skill review that emits staged suggestions and diffs.
3. Durable outbound-delivery obligations across Channel daemon restarts.
4. Event-loop heartbeat watchdogs rather than port-only liveness.
5. Task-scoped tool permissions and MCP include whitelists.
6. Docker/SSH execution-backend interfaces for isolated jobs.

Provider resolution and failover are lower priority for KA because model
provider ownership intentionally belongs to Codex/Claude Code, not the KA
application layer.

## Promotion gates

Do not promote Hermes beyond an experiment until all of these pass:

- pinned-version install and rollback are reproducible;
- only the intended MCP tools appear in the model schema;
- prompt injection in KB content cannot grant new tools or host access;
- no Hermes process can read KA secrets or the Markdown KB directly;
- first-token streaming, interruption, duplicate-delivery, and reconnect tests
  pass on the chosen channel transport;
- memory and skill writes are staged for review;
- CPU, memory, disk, and session-database growth are measured over a multi-day
  soak test;
- an upgrade contract test covers MCP schemas and session continuity.

