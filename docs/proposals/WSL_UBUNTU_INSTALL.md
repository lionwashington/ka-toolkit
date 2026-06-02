# Proposal B: Windows WSL (Ubuntu) install support

> Status: **draft pending review** (2026-06-01, drafted by ka-dev2)
> Target platform: Windows 11 + WSL2 + Ubuntu 22.04/24.04

## 1. Goal

Let knowledge-assistant install and run inside WSL2 Ubuntu, with functionality aligned to macOS at the "daily-usable" level:
workshop (tmux multi-pane CC) + telegram-channel daemon + capture/distill pipeline + cron scheduled tasks + kb / the various MCPs.

Non-goals: native Windows (non-WSL); macOS-exclusive capabilities (such as the `macos-automator` MCP) are simply skipped on Linux.

## 2. Platform Dependency Checklist

| Dependency | macOS | WSL Ubuntu | Notes |
|---|---|---|---|
| node | nvm | nvm (same) / `apt`+nodesource | install.sh already sources `~/.nvm/nvm.sh`, cross-platform |
| pnpm | corepack/npm | same | cross-platform |
| python3 | system built-in | `apt install python3` | yaml-parse and others depend on python3 |
| uv | brew | `curl -LsSf astral.sh/uv/install.sh` | python MCPs like hkprop/ibkr use a uv venv |
| tmux | brew | `apt install tmux` | workshop core |
| git | built-in | `apt install git` | — |
| gogcli | `brew install gogcli` | **Linux binary** (not brew) | `/mail` `/calendar`; download the corresponding release |
| lark-cli | (optional) | same (external CLI) | only Proposal A's lark-channel needs it |
| **cron backend** | launchd (implemented) | **systemd-timer or crontab (the gap)** | see §3, the main work |

## 3. Core Gap: cron backend (the only real code gap)

### 3.1 Current state

`ops/lib/cron/backend-adapter.sh`'s backend abstraction is in place, but:
- **launchd** (macOS): fully implemented.
- **systemd** (Linux): a **stub** — `backend::install/uninstall` simply `return 1` reporting "not implemented in Phase 1".

The good news: **the job runner `cron-run.sh` and `schedule-parser.sh` are already platform-agnostic**. `schedule-parser` can map both the launchd plist's `StartCalendarInterval` and a crontab expression (`19-cron-linux-crontab.sh` has verified this). So what's missing is **only the "register the schedule with the OS" layer**.

### 3.2 Two implementation routes

#### Route B-cron: crontab backend (recommended starting point, lowest risk)

Implement `backend::*` using crontab:
- `install`: write `* * * * * <cron-run.sh> <name>` into the user's crontab (use a unique comment marker `# ka-cron:<name>` for idempotent add/remove)
- `uninstall`: delete lines by the marker
- `list_installed` / `is_loaded`: grep the crontab marker
- schedule → crontab expr is already provided by schedule-parser

- ✅ simplest to implement, reuses the existing schedule-parser mapping
- ✅ a test skeleton already exists (19-cron-linux-crontab.sh)
- ⚠️ **WSL pitfall**: WSL's `cron` daemon does not auto-start by default. You need `sudo service cron start`, or enable `[boot] systemd=true` in `/etc/wsl.conf` and have systemd launch cron. The installer must detect this and prompt.

#### Route B-systemd: systemd user timer backend (cleaner, the stub already points to it)

Implement `backend::*` using systemd user units (the stub already defines `plist_path` as `~/.config/systemd/user/ka-cron-<name>.timer`):
- generate, per job, a pair: a `.service` (`ExecStart=cron-run.sh <name>`) + a `.timer` (`OnCalendar=...`)
- `install`: write the unit → `systemctl --user daemon-reload` → `enable --now <name>.timer`
- `uninstall`: `disable --now` + rm + reload
- `list_installed` / `is_loaded`: `systemctl --user list-timers` / `is-active`
- needs a new systemd unit generator (the counterpart to the existing `plist-gen.sh`)

- ✅ most symmetric with the launchd model (declarative, OS-managed, observable via `list-timers`)
- ✅ `OnCalendar` is expressive enough (daily HH:MM / every Nh)
- ⚠️ depends on WSL2 having systemd enabled (`/etc/wsl.conf` `[boot] systemd=true`, supported by default in newer WSL); `systemctl --user` needs lingering (`loginctl enable-linger`) to run without a login session

### Recommendation

**Do B-cron (crontab) first to get to usable**, and treat B-systemd as the better backend when "WSL has systemd enabled." Add a probe layer to `detect_backend()`: on Linux, if `systemctl --user` is available and systemd is enabled → use systemd, otherwise fall back to crontab. Both are inexpensive to implement, since the runner and schedule parsing already exist.

## 4. daemon supervision (also part of the cron layer)

The telegram-channel daemon's "every-minute start.sh patrol" self-heal mechanism (README §self-heal) relies on crontab/launchd on macOS. WSL reuses the same backend from §3:
- crontab route: `* * * * * runtime/daemon/start.sh`
- systemd route: a single `ka-daemon-supervisor.timer` (every minute) or just make the daemon a `Restart=always` `.service` (better, eliminates the patrol)

> Optional optimization: under WSL/systemd, make the daemon a `Restart=always` long-running service directly — cleaner than "every-minute patrol" — but to stay aligned with macOS, start with the patrol model.

## 5. Platform-adaptation check for the remaining components

| Component | WSL status |
|---|---|
| workshop / tmux | ✅ tmux is cross-platform; `ka workshop` is pure bash + tmux, no mac dependency |
| telegram daemon | ✅ node + express + grammy, `127.0.0.1:9877` local loopback, self-contained inside WSL |
| capture/distill hooks | ✅ node CLI (already noExternal self-contained), platform-agnostic |
| core-cli / config-cli | ✅ same as above |
| kb / knowledge-store | ✅ pure node + files, the Obsidian vault path uses $HOME |
| python MCPs (hkprop/ibkr/amap/opennutrition) | ✅ uv venv, cross-platform; confirm no mac-exclusive system libraries |
| `macos-automator` MCP | ❌ macOS-exclusive → not installed/skipped on WSL |
| `gogcli` (mail/calendar) | ⚠️ switch to the Linux binary, bring OAuth credentials from mac or re-auth |
| install.sh `LAUNCHAGENTS_DIR` / launchctl section | ⚠️ only runs on Darwin; needs to be wrapped by `detect_backend`, Linux doesn't touch launchctl |

## 6. Changes Needed in install.sh

1. `deploy_cron` / the cron install section: change the hardcoded launchctl/`~/Library/LaunchAgents` logic to go through `backend-adapter` (partly already does; need to audit the launchctl direct calls in install.sh's §switch_cron section)
2. platform detection: branches outside Darwin don't run launchctl, call the backend abstraction
3. dependency precheck: clearly error out when python3 / tmux / uv are missing (fail-closed style, no silent fallback)
4. docs/INSTALL: add a WSL chapter (dependency install + WSL systemd/cron enablement steps)

## 7. Verification

- The existing `ops/tests/cases/19-cron-linux-crontab.sh` is an e2e skeleton for Linux crontab and can be extended into a backend-level test
- Run install.sh dry-run + cron backend unit tests in a Docker Ubuntu (CI-friendly, can also be verified locally on mac via docker)
- True WSL end-to-end (tmux + daemon + telegram) to be accepted by you on a Windows machine

## 8. Effort Estimate

| Phase | Content | Size |
|---|---|---|
| P1 | crontab backend implementation (backend::* for crontab) + unit tests | medium |
| P2 | systemd backend implementation + unit generator + detect_backend dual-route probe | medium |
| P3 | install.sh platform-branch consolidation (wrap launchctl inside Darwin) + dependency precheck | medium |
| P4 | docs/INSTALL WSL chapter (incl. WSL systemd/cron enablement, gogcli Linux binary) | small |
| P5 | Docker Ubuntu CI verification + your acceptance on real WSL | medium |

## 9. Decision Points Awaiting Your Call

1. cron backend: **crontab to start + systemd dual-route** (my recommendation), or just one of them?
2. Under systemd, should daemon supervision go straight to a `Restart=always` service (leaving the patrol model)?
3. WSL acceptance: do you have a ready Windows + WSL2 environment for end-to-end testing?
4. gogcli/OAuth credentials: migrate from mac, or re-auth on WSL?
