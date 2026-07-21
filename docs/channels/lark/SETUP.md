# LarkPlatform Install & Test (on a machine with Lark + lark-cli)

Connect a Claude Code session to a Lark group: send a message in the group → cc receives it; cc calls `reply` → it goes back to the group.

> Deploy is via `install.sh`: `./install.sh --only lark-daemon --channel-kind=lark` bundles and selects only Lark. The combined `--only daemon` target remains available when both platform runtimes are wanted. Supervise with a cron self-heal job (see §5). Attachments ARE supported (image/file/audio/video → `lark-cli +messages-resources-download` → `attachments/` → surfaced as `meta.attachment_path`). See `docs/INSTALL_UBUNTU.md` for the full deploy.

---

## 0. Architecture in One Sentence

`channels/core` is the platform-agnostic kernel (session / routing / MCP / HTTP / dispatch / probe-M6 /
re-adopt reconnect / cc2cc / 404 self-heal). `lark-platform.ts` only implements Lark I/O. The deployed daemon runs at
`http://127.0.0.1:9876`, and cc connects to it via MCP (dev-channel).

```
Lark group ──lark-cli poll──> lark daemon(9876) ──MCP notification──> Claude Code session
Lark group <──webhook POST── lark daemon       <──reply tool── Claude Code session
```

---

## 1. Prerequisites

- **Node 22+**: `node -v`
- **pnpm**: `npm i -g pnpm`
- **lark-cli**: installed and **authenticated** (logged in with your Lark app credentials; needs `im:message`/read-message permission).
  Verify: `lark-cli im +chat-messages-list --chat-id <some group id> --page-size 1 --format json` returns `{"ok":true,...}`.
- This repo is cloned and `pnpm install` has been run (needed for the esbuild bundle step).

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

## 3. Deploy + Configure

```bash
# Build & deploy the daemon bundle. Make lark the active kind:
./install.sh --channel-kind=lark --only lark-daemon
```

This produces `~/.knowledge-assistant/channels/lark-daemon/` (a self-contained `daemon.mjs` + the
`daemon.sh`/`start.sh`/`stop.sh`/`status.sh` scripts; no `.ts`, no `node_modules`). The daemon reads
config + secrets from the SHARED `~/.knowledge-assistant/config/` bucket — there is no per-daemon
`config.json`.

**Non-secret tuning** — `~/.knowledge-assistant/config/config.yaml` (template: `config/config.example.yaml`):

```yaml
channel_kind: lark            # makes lark the active daemon
channels:
  lark:
    port: 9876
    poll_interval_seconds: 1  # global base poll tick
    page_size: 10             # lark-cli chat-messages-list page size
    lark_cli_bin: lark-cli    # path or $PATH name
```

**Secrets** — `~/.knowledge-assistant/config/secrets.yaml` (`chmod 600`; template: `config/secrets.example.yaml` has a commented `channels.lark` block):

```yaml
channels:
  lark:
    self_open_id: "ou_your_openid"
    groups:
      oc_group1_chatid:
        name: "Test Group 1"
        webhook_url: "https://open.larksuite.com/open-apis/bot/v2/hook/xxx"
        poll_interval_seconds: 5   # optional per-group override of the global tick
      oc_group2_chatid:
        name: "Test Group 2"
        webhook_url: "https://open.larksuite.com/open-apis/bot/v2/hook/yyy"
```

- 🔴 `self_open_id` and the per-group `webhook_url` come **only** from `secrets.yaml channels.lark` — never from `config.yaml` or the environment. `secrets.yaml` holds the webhook token; **never commit it** (it is `chmod 600` and gitignored).
- The daemon **fails closed**: an empty/missing `self_open_id` means it refuses to start (run `ka doctor` to surface a misconfig).

---

## 4. Start the daemon

```bash
~/.knowledge-assistant/channels/lark-daemon/start.sh
```

Verify it's alive + config took effect:

```bash
curl -s http://127.0.0.1:9876/api/status | python3 -m json.tool
```

You should see `"ok": true`, `channels_online` (no cc connected yet, so empty `{}`), plus Lark's
`poll_errors_total` / `last_poll_at` / `watermarks`. If `poll_errors_total` keeps climbing = lark-cli
calls are failing (check auth / `lark_cli_bin` / chat_id).

---

## 5. Cron self-heal supervisor

```cron
* * * * * ~/.knowledge-assistant/channels/lark-daemon/start.sh >> ~/.knowledge-assistant/channels/lark-daemon/supervisor.log 2>&1
```

Every minute `start.sh` is invoked: if the daemon is alive → no-op; if dead → re-launch via double-fork.
Max ~60s outage after any death. (`ka cron` can manage this job for you.)

---

## 6. Connect a Claude Code session (cc)

Use the `claude-ch` wrapper (at `~/.local/bin/claude-ch`): it sanitizes the channel name to `a-z0-9_-` and overrides the MCP URL to `…/mcp?name=<name>`.

```bash
claude-ch main --dangerously-skip-permissions --dangerously-load-development-channels "server:lark-channel"
```

- The `main` is this cc's channel name; for multiple cc's, use different names (`main` / `dev` …),
  and target with `to dev: …` in the group, or default to `main` with no prefix.
- If a "Loading development channels" confirmation dialog pops up at startup, confirm it (it's for local development).

---

## 7. End-to-end Verification

1. **Inbound**: in a configured Lark group, send a message **from your own account** (e.g. `hello lark`).
   Within a few seconds (≤ poll interval), cc receives a message tagged with the Lark source (including `chat_id` = group id).
   - Messages from others, from bots, or card messages → won't come in (self filter + card filter).
2. **Outbound**: have cc call `reply` (passing the `chat_id` from the incoming tag). The group receives a message
   with `**[#<number>-main]**` in its own paragraph above the response body.
3. **Routing**: send `to <another channel name>: content` in the group → delivered to that channel; no prefix → `main`.
4. **Offline replay**: messages sent in the group while cc is disconnected are delivered after cc reconnects (the watermark doesn't advance).
5. **Daemon-restart auto-recovery**: restart the daemon (`stop.sh` then `start.sh`); cc **needs no restart, no touch**,
   the receive line is reconnected automatically via re-adopt (when downtime is short; see `docs/channels/telegram/ARCHITECTURE.md` §6c/§6d).

---

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| `/api/status` unreachable | daemon not up; look at `~/.knowledge-assistant/channels/lark-daemon/daemon.stdout.log` / `channel.log` |
| `poll_errors_total` keeps climbing | lark-cli calls failing: auth expired? `lark_cli_bin` path? chat_id correct? Run that lark-cli command manually to see the error |
| cc not receiving messages | ① did you send from your own account (`self_open_id` must match)? ② is the group's chat_id in `secrets.yaml`? ③ is there a dispatch in the daemon log? ④ is cc actually connected (`channels_online` in `/api/status` includes your name)? |
| cc can receive but not reply (reply fails) | is `webhook_url` correct, is that custom bot still in the group? Check the daemon log's `reply failed` webhook response |
| same message delivered multiple times | should not happen (message_id dedup + minute-level watermark); if it does, paste the daemon log |
| daemon refuses to start | fail-closed: `secrets.yaml channels.lark.self_open_id` is empty/missing — fill it (run `ka doctor`) |

---

## 9. Running Tests (no real Lark needed)

```bash
cd channels/lark && pnpm test     # pure-function unit tests + e2e (fake lark-cli + mock webhook + real MCP client)
```

The e2e uses a fake lark-cli (script) + mock webhook + the real channel-core daemon, with zero dependency on real Lark, verifying the full send/receive/filter/dedup/routing.
</content>
