# LarkPlatform Install & Test (on a machine with Lark + lark-cli)

Connect a Claude Code session to a Lark group: send a message in the group → cc receives it; cc calls `reply` → it goes back to the group.

> Current status: this is the **dev/test workflow** (source mode, foreground). Packaging/install.sh deployment + supervision (mirroring telegram's `runtime/lark-daemon`) is the later phase D0. Attachments are not yet supported (P3).

---

## 0. Architecture in One Sentence

`channel-core` is the platform-agnostic kernel (session / routing / MCP / HTTP / dispatch / probe-M6 /
re-adopt reconnect / cc2cc / 404 self-heal). `lark-platform.ts` only implements Lark I/O. The daemon runs at
`http://127.0.0.1:9876`, and cc connects to it via MCP (dev-channel).

```
Lark group ──lark-cli poll──> lark daemon(9876) ──MCP notification──> Claude Code session
Lark group <──webhook POST── lark daemon       <──reply tool── Claude Code session
```

---

## 1. Prerequisites

- **Node 22+** (needs to support `node --experimental-strip-types`): `node -v`
- **pnpm**: `npm i -g pnpm`
- **lark-cli**: installed and **authenticated** (logged in with your Lark app credentials; needs `im:message`/read-message permission).
  Verify: `lark-cli im +chat-messages-list --chat-id <some group id> --page-size 1 --format json` returns `{"ok":true,...}`.
- This repo is cloned and `pnpm install` has been run.

---

## 2. Get Lark Credentials (3 items)

1. **`self_open_id`** (your own Lark open_id, `ou_…`) — the daemon only delivers messages **you yourself** sent (anti-injection).
   - How to get it: query yourself in the Lark Open Platform "API Explorer", or use `lark-cli` (e.g. a contact query) to obtain `open_id`.
2. **Each group's `chat_id`** (`oc_…`) — the groups to listen to.
   - How to get it: list groups via `lark-cli`, or check the group settings; you can also send a message and grab it from the API Explorer.
3. **Each group's `webhook_url`** — the daemon uses it to **send messages back to the group**.
   - How to get it: in that group, "Add Bot → Custom Bot" → copy its Webhook URL
     (looks like `https://open.larksuite.com/open-apis/bot/v2/hook/<token>`).
   - ⚠️ The token in this URL is a secret — **don't share it, don't commit it to git**.

---

## 3. Configuration

```bash
mkdir -p ~/.lark-channel
cp packages/lark-channel/config.example.json ~/.lark-channel/config.json
$EDITOR ~/.lark-channel/config.json
```

How to fill it (schema in `config.example.json`):

```json
{
  "self_open_id": "ou_your_openid",
  "poll_interval_seconds": 3,
  "page_size": 10,
  "lark_cli_bin": "lark-cli",
  "http_host": "127.0.0.1",
  "http_port": 9876,
  "groups": {
    "oc_group1_chatid": { "name": "Test Group 1", "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/xxx", "poll_interval_seconds": 3 },
    "oc_group2_chatid": { "name": "Test Group 2", "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/yyy" }
  }
}
```

- `lark_cli_bin`: if lark-cli is on PATH, set `"lark-cli"`; otherwise an absolute path.
- `poll_interval_seconds`: global poll interval; each group can override it individually.
- 🔴 `config.json` contains the webhook token; **never commit to git** (`packages/lark-channel/.gitignore` already ignores `config.json`).

---

## 4. Start the daemon

```bash
bash packages/lark-channel/run-dev.sh
# Runs in foreground, logs to stderr + ~/.lark-channel/channel.log; Ctrl-C to stop.
```

Verify it's alive + config took effect (in another terminal):

```bash
curl -s http://127.0.0.1:9876/api/status | python3 -m json.tool
```

You should see `"ok": true`, `channels_online` (no cc connected yet, so empty `{}`), plus Lark's
`poll_errors_total` / `last_poll_at` / `watermarks`. If `poll_errors_total` keeps climbing = lark-cli
calls are failing (check auth / `lark_cli_bin` / chat_id).

---

## 5. Connect a Claude Code session (cc)

cc connects to the daemon via the MCP "development channel". In the working directory you want to use as the channel:

```bash
# 1) Register the lark-channel MCP server (local scope), pointing at the daemon's /mcp?name=<channel name>
claude mcp add --transport http --scope local lark-channel "http://127.0.0.1:9876/mcp?name=main"

# 2) Start claude, loading this dev-channel
claude --dangerously-skip-permissions --dangerously-load-development-channels "server:lark-channel"
```

- The `main` in `?name=main` is this cc's channel name; for multiple cc's, use different names each (`main` / `dev` …),
  and target with `to dev: …` in the group, or default to `main` with no prefix.
- If a "Loading development channels" confirmation dialog pops up at startup, press Enter to confirm (confirming it's for local development).

---

## 6. End-to-end Verification

1. **Inbound**: in a configured Lark group, send a message **from your own account** (e.g. `hello lark`).
   Within a few seconds (≤ `poll_interval_seconds`), cc receives a message tagged with the Lark source (including `chat_id` = group id).
   - Messages from others, from bots, or card messages → won't come in (self filter + card filter).
2. **Outbound**: have cc call `reply` (passing the `chat_id` from the incoming tag). The group receives a message
   prefixed with `**[#<number>-main]** …`.
3. **Routing**: send `to <another channel name>: content` in the group → delivered to that channel; no prefix → `main`.
4. **Offline replay**: messages sent in the group while cc is disconnected are delivered after cc reconnects (the watermark doesn't advance).
5. **Daemon-restart auto-recovery**: restart the daemon (Ctrl-C then `run-dev.sh`); cc **needs no restart, no touch**,
   the receive line is reconnected automatically via re-adopt (when downtime is < ~2.5s; see docs/telegram-channel-design.md §6c/§6d).

---

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| `/api/status` unreachable | daemon not up; look at run-dev.sh foreground output / `~/.lark-channel/channel.log` |
| `poll_errors_total` keeps climbing | lark-cli calls failing: auth expired? `lark_cli_bin` path? chat_id correct? Run that lark-cli command manually to see the error |
| cc not receiving messages | ① did you send from your own account (self_open_id must match)? ② is the group's chat_id in config? ③ is there a dispatch in the daemon log? ④ is cc actually connected (`channels_online` in `/api/status` includes your name)? |
| cc can receive but not reply (reply fails) | is webhook_url correct, is that custom bot still in the group? Check the daemon log's `reply failed` webhook response |
| same message delivered multiple times | should not happen (message_id dedup + minute-level watermark); if it does, paste the daemon log |

---

## 8. Running Tests (no real Lark needed)

```bash
cd packages/lark-channel && pnpm test     # 19 tests: pure-function unit tests + e2e (fake lark-cli + mock webhook + real MCP client)
```

The e2e uses a fake lark-cli (script) + mock webhook + the real channel-core daemon, with zero dependency on real Lark, verifying the full send/receive/filter/dedup/routing.
