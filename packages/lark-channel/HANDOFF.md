# lark-channel handoff note — 2026-05-21 ~14:50

> For the new Claude session after a restart: read this + `ARCHITECTURE.md` and you can pick up seamlessly.

## Why the Restart
I (the previous main session) repeatedly restarted the daemon to deploy v0.5.0, which **orphaned this session's dev-channel notification consumer** (bound to a dead old MCP session). Symptom: `reply` works, but Lark messages aren't received. The only fix = a full restart of the Claude process (this one).

## Current State (important)
- **daemon v0.5.0 is deployed, tested, and running stably (pid in `/api/status`). Do NOT restart it.**
- **Commandment**: when you must restart the daemon after editing `server.ts`, all connected clients must be fully restarted along with it (404 self-heal only restores POST, not the notification consumer). Don't restart the daemon for routine troubleshooting.

## What v0.5.0 Added (on top of the v0.4 owner model)
1. **Lenient routing prefix**: `to`/`2` both work, spaces flexible, colon optional. `to main:` `to main` `2main` `2 main` `2 main:` `2 main :` are all equivalent. Parser `parseRoutingPrefix` regex `/^\s*(?:to|2)\s*([A-Za-z0-9_-]+)\s*([:：])?\s*/i`
2. **Stable channel numbers**: `state.channel_numbers` (name→number) is persisted, assigned on first sight, retained across disconnect, reused on reconnect. You can route by number with `to 1:` `to2:` `to 3`
3. **No-colon anti-misroute**: with a colon = explicit routing (a miss returns a hint); without a colon = route only if the target matches an online channel (name or number), otherwise treat as a plain message and send the full text to main
4. **Delivery changed back to "send to all same-named sessions"** (not owner-only): because the session Claude's notification consumer is bound to may not be the owner, owner-only delivery may not surface. Delivering to all same-named sessions → the consumer one receives it, the rest silently discard → surfaces exactly once
5. `/api/status` adds the `channel_numbers` field; route-miss hints carry the number `name(#number)`

Unit tests all green (`/tmp/test_route.mjs` verified all formats + numbers + anti-misroute).

## After Restart, Please Verify
1. Call `mcp__lark-channel__reply` once for `oc_REPLACE_WITH_GROUP_CHAT_ID` (Example Group A) to confirm it can send
2. Have the user send a message in Lark (e.g. `to 1: test`) to confirm it's **received** (the consumer is freshly bound this time, so it should work)
3. `curl -s localhost:9876/api/status | python3 -m json.tool` to check active_owners / channel_numbers

## TODO (docs still at v0.4)
- `ARCHITECTURE.md` / `README.md` / `SKILL.md` are updated to v0.4.0; **v0.5.0's lenient prefix + numbered routing + delivery-back-to-all-same-named are not yet written into the docs** and need to be added.
- The memory note `lark_channel_system.md` is updated to v0.5 (see the top of that file).

## Key Files
- `~/.lark-channel/server.ts` (v0.5.0)
- `~/.lark-channel/ARCHITECTURE.md` / `README.md`
- `~/.claude/skills/lark-channel/SKILL.md`
- `~/.local/bin/claude-ch` (`claude-ch <name> [claude args…]`)
- Routing-parse unit test: `/tmp/test_route.mjs`
