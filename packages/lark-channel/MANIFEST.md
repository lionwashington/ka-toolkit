# lark-channel — source + docs bundle

Bundle time: see each file's mtime; daemon version v0.6.2.

## Contents
| File | Description |
|---|---|
| server.ts | daemon main source (Node + `--experimental-strip-types`) |
| package.json / package-lock.json | dependency manifest (node_modules not bundled, restore with `npm i`) |
| daemon.sh / start.sh / stop.sh / status.sh | lifecycle scripts |
| config.json | **real config, contains bot webhook URL (secret) + self_open_id — do not share** |
| config.example.json | redacted example (webhook/open_id replaced with placeholders) |
| README.md | overview + quickstart + ops |
| ARCHITECTURE.md | architecture design |
| HANDOFF.md | handoff note |
| skill/SKILL.md | Claude Code ops skill |
| .gitignore | — |

## Not Bundled (deliberately excluded)
- node_modules/ (large; restore with `npm i`)
- *.log (supervisor.log alone is close to 600MB)
- state.json / *.pid / *.lock (runtime state)
- .git/ (version history)

## Restore & Run
1. `npm i`
2. Fill in config.example.json and rename to config.json (or use the bundled real config.json)
3. `./start.sh` (cron pulls it up every minute as a backstop); `./status.sh | jq` to check health
