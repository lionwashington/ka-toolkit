# SecureLink renewal Skill

`securelink-renewal` renews an already-running, already-authenticated SecureLink
VPN client on the Windows host from WSL. It supports the observed forced-expiry
flow: try `Renew now`; if that does not open the MFA challenge, disconnect the
existing workbench connection once, reconnect once, and submit one fresh TOTP.

It is deliberately not a login, logout, reset, repair, update, installation, or
general VPN-management tool.

## Design, runtime, and discovery

| Layer | Path | Contract |
|---|---|---|
| Versioned design source | `kb/skills/securelink-renewal/` | Reviewable code, Skill instructions, UI markers, and deterministic helpers only |
| Deployed KA product | `$KA_HOME/kb/skills/securelink-renewal/` | Copy produced by `install.sh`; never hand-edited |
| Codex discovery | `${CODEX_HOME:-~/.codex}/skills/securelink-renewal` | Symlink to the deployed KA product |
| Claude discovery | `~/.claude/skills/securelink-renewal` | Symlink to the same deployed KA product |
| Runtime data | wrapper-managed directory under `/tmp/securelink-renewal.*` | Window-only screenshots, mode `0700` directory / `0600` files, deleted through the guarded cleanup command |
| Persistent secrets | `$KA_HOME/config/secrets.yaml` | Not used by this Skill |

The checked-in code contains no user name, account identifier, VPN address,
device identifier, captured screenshot, log excerpt, window handle, TOTP seed,
or TOTP value. The installed Skill must have the same property.

## Isolation rules

### Code and documentation

Git may contain only reusable implementation and generic UI/state descriptions.
Host-specific executable discovery is restricted to the documented SecureLink
installation path and is validated at runtime. Transient window handles,
coordinates, network addresses, process IDs, and screenshots are never fixtures
or defaults.

### Private runtime information

A SecureLink screenshot can contain an account avatar, virtual IP, MAC address,
resource names, or policy details. The wrapper creates the private directory and
pre-creates the screenshot at restrictive permissions; callers cannot select an
arbitrary path, overwrite a file, or target a symlink. Capture only the
SecureLink window, inspect it locally, and invoke the guarded cleanup command
immediately. Never capture the desktop and never attach a screenshot to a report
or commit.

`status` reads the client log internally but emits only sanitized service,
process, window geometry, VPN state, remaining-time, and renewal-success timing
fields. Do not expose or copy the general SecureLink log.

### Secrets and TOTP

The Skill needs no persistent credential. A six-digit TOTP is ephemeral input,
not configuration, and must never be written to `secrets.yaml`, a file, command
argument, environment variable, clipboard, shell history, screenshot, log, note,
or summary.

The submitter derives its baseline directly from the managed screenshot already
inspected by the operator. It requires an exact full-window match during
preflight and again before any input. After typing, only the explicitly bounded
TOTP input rectangle may differ; all other pixels are checked again before
Continue. It stores no additional image, disables TTY echo before declaring
itself armed, reads exactly one line, restores the terminal, validates six ASCII
digits, and passes the value to PowerShell through anonymous standard input. It
clears its in-memory variables after the one allowed submit. A content change,
expired value, or rejected value is never submitted or replayed.

Chat transport may retain a message supplied by the user. Warn before requesting
the TOTP; when chat retention is unacceptable, the user must type directly into
SecureLink and the Skill performs only read-only verification afterward.

## Safety state machine

1. Enumerate every visible top-level window owned by the expected SecureLink
   executable and capture each by a fresh handle.
2. Click only a visually verified forced-renewal `Renew now` control. It is the
   sole idempotent control and has a bounded retry limit.
3. If no challenge appears, visually verify `Connected`, click it once, wait for
   `Disconnected`, then click `Connect` once. Do not repeat either toggle.
4. Accept the standard MFA dialog only when it has a six-digit challenge and
   `Continue`. A passive `Reset TOTP Key` link may be visible but is never a
   target; stop if the client actually enters reset/binding.
5. Arm the no-echo one-shot submitter before requesting a fresh TOTP. Submit once
   and verify `connected` plus a renewed validity period near the configured
   policy limit.

Any ambiguous window, geometry change, login/reset page, missing transition, or
unexpected VPN state stops the workflow without further clicks.

## Installation

Preview and install through KA's normal design-to-runtime switch:

```bash
./install.sh --only skills --skill securelink-renewal --switch --dry-run
./install.sh --only skills --skill securelink-renewal --switch
```

Verify the two-stage layout:

```bash
test -f "$HOME/.knowledge-assistant/kb/skills/securelink-renewal/SKILL.md"
test -L "${CODEX_HOME:-$HOME/.codex}/skills/securelink-renewal"
readlink "${CODEX_HOME:-$HOME/.codex}/skills/securelink-renewal"
```

The installer refuses to replace an existing real directory in a discovery
root. Before adopting a manually installed copy, move it to a private backup
outside the discovery root, run the standard install, verify the runtime copy,
then remove the backup only after review.

## Verification

Repository-level checks must not perform a real click or use a real TOTP:

```bash
python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
  kb/skills/securelink-renewal
bash -n kb/skills/securelink-renewal/scripts/securelink.sh
REPO="$PWD" bash tests/cases/29-codex-skills.sh
```

On WSL, `status`, per-window `capture`, and every `--dry-run` command may be used
for production verification. A real disconnect, reconnect, or TOTP submission
requires an explicit renewal request and the visual checks in the Skill.
