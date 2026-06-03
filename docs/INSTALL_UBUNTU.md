# Installing the full ka stack on Ubuntu (incl. WSL2) — with the channel daemon on Lark

Install the entire knowledge-assistant stack onto a single Linux machine: ka CLI + the various MCPs + hooks + skills +
workshop (multi-CC tmux collaboration) + **channel daemon = Lark** (not telegram) +
cron scheduled tasks. Each CC sends/receives through a Lark group: send a message in the group → the CC receives it; the CC calls `reply` → it goes back to the group.

> Verified end-to-end in Docker Ubuntu (Linux aarch64 / Node 22 / pnpm / python3): the install flow,
> the lark daemon build+run, the lark tests 19/19, the crontab cron backend — all passed (`ops/tests/ubuntu-lark.Dockerfile`).
> Lark attachments ARE supported (image/file/audio/video → downloaded via `lark-cli +messages-resources-download` to the daemon's `attachments/`, surfaced to the CC as `meta.attachment_path` to Read). Cross-platform cc2cc in workshop is not done (lark groups can talk to each other, isolated from telegram).

---

## 1. Prerequisites

```bash
# Node 22+ (nvm recommended; install.sh sources ~/.nvm/nvm.sh)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22

corepack enable                          # enable pnpm
sudo apt update && sudo apt install -y python3 git tmux cron   # basics
curl -LsSf https://astral.sh/uv/install.sh | sh                # uv (python MCP venv)
```

- **lark-cli**: install it separately and **complete authentication** (your Lark app credentials, requiring read-message permission).
  Verify: `lark-cli im +chat-messages-list --chat-id <some group id> --page-size 1 --format json` returns `{"ok":true,...}`.

`./install.sh` has a dependency precheck at the top that clearly warns about anything missing.

### WSL2 note (cron daemon)

WSL doesn't auto-start cron by default. Pick one:
- `sudo service cron start` (manually on each boot, or add it to your shell profile);
- or write `[boot]\nsystemd=true` in `/etc/wsl.conf`, restart WSL, and let systemd launch cron.

Without cron: the daemon self-heal patrol + scheduled tasks (daily-brief/distill) won't run, but manually sending/receiving Lark messages is unaffected.

---

## 2. Get the Code + Build

```bash
git clone <repo-url> knowledge-assistant && cd knowledge-assistant
pnpm install
# pnpm 10+ blocks native build scripts by default; rerun esbuild's (needed for the daemon/MCP bundling):
pnpm rebuild esbuild
pnpm build            # produces dist for hooks/core/opennutrition etc. (needed by install's deploy step)
```

---

## 3. Obtain Lark Credentials (3 items)

1. **`self_open_id`** (your own `ou_…`) — the daemon only delivers messages **you** sent (to prevent injection).
2. **Each group's `chat_id`** (`oc_…`) — the groups to listen to.
3. **Each group's `webhook_url`** — obtained in the group via "Add Bot → Custom Bot" as the Webhook
   (`https://open.larksuite.com/open-apis/bot/v2/hook/<token>`). The daemon uses it to send messages back to the group.
   ⚠️ the token is a secret — don't share it, don't commit it to git.

---

## 4. Install (channel = lark)

```bash
# --channel-kind=lark: make lark the ACTIVE daemon (persisted to config.yaml).
# Both daemons (telegram + lark) are always deployed; only the active one starts.
# --switch: point ka's symlink/cron/hooks/skills at runtime and start the daemon.
./install.sh --channel-kind=lark --switch
```

install will: deploy ka+ops / the various MCPs / hooks / skills / **both channel daemons**;
write `channel_kind: lark` into `~/.knowledge-assistant/config.yaml`; start **only** the lark daemon.
(On Linux the cron switch goes through the crontab backend and doesn't touch launchd.)

Then **fill in the real Lark credentials** (install only seeds a placeholder config):

```bash
$EDITOR ~/.knowledge-assistant/runtime/lark-daemon/config.json
# fill in self_open_id, groups{ "oc_groupid": { "name":"…", "webhook_url":"…" } }
~/.knowledge-assistant/runtime/lark-daemon/stop.sh
~/.knowledge-assistant/runtime/lark-daemon/start.sh
curl -s http://127.0.0.1:9876/api/status | python3 -m json.tool   # ok:true + lark statusFields
```

---

## 5. Start workshop (mates on lark)

```bash
ka workshop          # each mate pane connects to the active daemon (lark, from config.yaml)
```

The active daemon comes from `config.yaml channel_kind` (set above) — **no env var needed,
on any command**. In the group, use `to <channel name>: …` to target, no prefix → `main`.

> To switch the active daemon later: `./install.sh --channel-kind=telegram` (rewrites
> `config.yaml`), then restart the workshop. Both daemons are already deployed, so no
> redeploy is required.

> To manually attach just one CC (without workshop):
> ```bash
> claude mcp add --transport http --scope local lark-channel "http://127.0.0.1:9876/mcp?name=main"
> claude --dangerously-skip-permissions --dangerously-load-development-channels "server:lark-channel"
> ```

---

## 6. Scheduled Tasks (crontab backend)

```bash
# edit cron.yaml (daily-brief/distill etc.), then:
ka cron install        # on Linux it automatically uses the crontab backend (detect_backend → crontab)
ka cron list           # see installed jobs (marked # ka-cron:<name> in crontab)
crontab -l             # view the crontab lines directly
```

Make sure the cron daemon is running (see §1's WSL note).

### Lark daemon self-heal (recommended)

The lark daemon needs a supervisor so it auto-revives if it ever dies (the old
standalone `~/.lark-channel` had a `* * * * * start.sh` cron; the runtime daemon
needs the equivalent). Add it as a `ka cron` job — its `start.sh` is idempotent
(no-op when already up):

```bash
ka cron add --name lark-daemon --schedule "every 1m" --kind shell \
  --command "$HOME/.knowledge-assistant/runtime/lark-daemon/start.sh >> $HOME/.knowledge-assistant/runtime/lark-daemon/supervisor.log 2>&1" \
  --description "lark-channel daemon self-heal: idempotent start every 1 min"
ka cron install            # materializes to crontab (Linux) — `crontab -l` shows the # ka-cron:lark-daemon line
ka cron run lark-daemon    # foreground test (should report the daemon already up)
```

> Note: `ka cron` schedules use a DSL (`every 1m`, `daily 07:00`, …), **not** raw
> cron syntax (`* * * * *` is rejected). On Linux `ka cron install` selects the
> crontab backend automatically. The job only fires while the OS cron daemon is
> running (WSL: `sudo service cron start`, see §1).

---

## 7. End-to-End Verification

1. In the group, **using your own account**, send `hello`; within a few seconds the corresponding CC receives it (with a lark source tag + `chat_id`).
2. The CC calls `reply` (passing `chat_id`) → the group receives `**[#number-name]** …`.
3. `to <another channel>: …` → routes to that CC.
4. Restart the lark daemon (stop/start) → the CC **needs no restart and no touch**; the receive line reconnects automatically via re-adopt
   (see docs/telegram-channel-design.md §6c/§6d; when downtime is < ~2.5s).

To run the tests without a real Lark: `cd packages/lark-channel && pnpm test` (19 of them).

---

## 8. Troubleshooting

| Symptom | What to check |
|---|---|
| `/api/status` unreachable | the daemon didn't start; look at `~/.knowledge-assistant/runtime/lark-daemon/channel.log` |
| `poll_errors_total` rising | lark-cli calls are failing: auth? `lark_cli_bin` path? chat_id? run that lark-cli command manually and read the error |
| CC not receiving | ① was it sent from your own account (self_open_id) ② does config have that group's chat_id ③ does the daemon log show a dispatch ④ is the CC actually connected (does /api/status's channels_online list that name) |
| Can receive but can't reply | is the webhook_url correct, is the custom bot still in the group; check the daemon log for `reply failed` |
| cron not firing | the cron daemon isn't running (WSL: `sudo service cron start`); does `crontab -l` have a `# ka-cron:` line |
| node/pnpm not found (in cron) | cron-run.sh already sources nvm; confirm `~/.nvm/nvm.sh` exists |

---

## 9. Platform Differences Quick Reference (macOS ↔ Ubuntu)

| Item | macOS | Ubuntu |
|---|---|---|
| cron backend | launchd plist | **crontab** (`ka cron install` selects automatically) |
| channel daemon | telegram@9877 (default) | lark@9876 (`./install.sh --channel-kind=lark`; the active kind is persisted to `config.yaml channel_kind`, no env needed afterwards) |
| `macos-automator` MCP | present | skipped (not installed on Linux) |
| install launchctl section | runs | auto-skipped (Darwin only) |
