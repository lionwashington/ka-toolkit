---
name: securelink-renewal
description: Safely renew the running SecureLink VPN on the Windows host from WSL when a user asks to check or extend its connection validity with a short-lived TOTP code. Do not use for login, logout, reset, restart, password changes, TOTP setup, or TOTP reset.
---

# SecureLink Renewal

Renew only an already-running, already-authenticated Windows SecureLink connection. Treat every UI action as high risk because login, logout, reset, connection toggles, and renewal controls coexist in the application.

## Non-negotiable boundaries

- Never start, stop, restart, terminate, sign in to, sign out of, reset, repair, update, or reinstall SecureLink.
- Never click login, logout, reset, password, TOTP setup/reset, account switch, or security-key controls.
- Disconnect and reconnect only through the visually verified `Connected` / `Disconnected` workbench control, only as the fallback in this renewal workflow, and at most once each per invocation. Do not use this skill for ordinary VPN connection management.
- Never persist a TOTP code in a file, screenshot, log, shell history, command argument, environment variable, clipboard, note, or summary. Never repeat it back.
- Never pass a TOTP code to `exec_command`; arm the submitter with `exec_command` using `tty: true`, then deliver the code only through `write_stdin` to the waiting process. The wrapper must disable terminal echo before declaring itself armed.
- Never submit the same TOTP twice. A rejected or expired code requires a newly generated code and a newly armed submitter.
- Retry read-only checks and transient window operations with short bounded delays. The visually verified `Renew now` / `立即续期` entry is explicitly idempotent and may be clicked again while the same verified renewal notification remains or returns. No other click has this exception.
- Never retry a TOTP submission. A rejected or expired TOTP requires a new code and a newly armed submitter.
- Do not infer controls from fixed coordinates. Enumerate every visible SecureLink top-level window, capture the intended window by its fresh handle, and visually verify it before every state-changing click.

The source chat may retain a user-sent TOTP even though the local workflow does not. Tell the user before requesting a code. If they require no chat retention, have them type directly into SecureLink instead and only verify the result.

## Workflow

Use the bundled WSL wrapper:

```bash
SKILL="$HOME/.codex/skills/securelink-renewal"
"$SKILL/scripts/securelink.sh" status
```

### 1. Preflight and classify the renewal entry point

Run `status`. Continue to visual inspection when both of these are true:

- the Windows service is running;
- one or more visible top-level windows titled `SecureLink` are owned by `C:\Program Files\SecureLink\SecureLink.exe`.

SecureLink may simultaneously expose a narrow renewal notification and a regular workbench. `status.visibleWindows` is the authoritative inventory. Never rely on `Get-Process.MainWindowHandle`, and never assume one Electron process means one visible window.

Do not require `connected` at this stage. SecureLink has two valid renewal entry states:

- `connected`: a pre-expiry renewal action may be shown in the normal workbench;
- `idle`: after the forced-disconnect timer reaches zero, SecureLink shows a narrow full-height `SDP Connection Notification` with a `Renew now` button. In this state, remaining minutes may be absent. This is the expected forced-renewal path, not evidence of logout.

Stop on any other VPN state unless a fresh screenshot unambiguously shows the exact renewal notification described below. If remaining validity is already close to the client-configured fresh policy limit and no renewal entry is visible, report that renewal is unnecessary. Never hardcode a validity duration or manufacture a renewal prompt.

Capture every listed SecureLink window by its fresh handle. The wrapper itself creates a new owner-only directory under `/tmp`, pre-creates the screenshot at mode `0600`, and refuses caller-selected paths, symlinks, or overwrites:

```bash
"$SKILL/scripts/securelink.sh" capture WINDOW_HANDLE
```

Retain the returned `path` only in memory. After inspecting it, remove it through the managed lifecycle command: `"$SKILL/scripts/securelink.sh" cleanup CAPTURE.png`. The cleanup command refuses paths outside a correctly owned `0700` SecureLink capture directory with a regular `0600` screenshot.

Inspect the image with `view_image` and classify exactly one safe entry point:

- Workbench path: the normal SecureLink workbench visibly offers `立即续期` or `Renew now`.
- Forced-renewal path: a panel titled `SDP Connection Notification` (or its Chinese equivalent) says that the forced-disconnection time has been reached and visibly offers `Renew now` / `立即续期`.

The forced-renewal panel may be narrow and full-height. Treat all dimensions as dynamic geometry to match between capture and click, never as a fixed UI signature and never as a reason by itself to reject the panel.

Record the selected handle, width, height, and renewal button coordinates relative to that capture. If the exact renewal action is absent from every window, stop and report that the client is not currently offering renewal.

### 2. Click the renewal entry once, then verify the challenge

Run a geometry-only validation first, then send one click for the current attempt:

```bash
"$SKILL/scripts/securelink.sh" click-renew WINDOW_HANDLE X Y WIDTH HEIGHT --dry-run
"$SKILL/scripts/securelink.sh" click-renew WINDOW_HANDLE X Y WIDTH HEIGHT
```

After the click, wait briefly and recapture. A notification that disappears and then returns means the renewal challenge did not open; it does not make the click outcome unsafe. Use this bounded retry loop:

1. Wait 500–1000 ms, rerun `status`, and capture every visible SecureLink window for up to 3 seconds while the UI transitions.
2. If a six-digit TOTP challenge appears in any window, leave the loop and use that window's handle and geometry.
3. If the same `SDP Connection Notification` and exact `Renew now` / `立即续期` action remains or returns, recalculate its coordinates from the new capture and click it again.
4. Repeat until the TOTP challenge appears, with a safety cap of 10 renewal-entry clicks or 30 seconds per invocation.
5. If any different or ambiguous screen appears, stop immediately. Never click while the notification is absent, and never reuse a handle or coordinates without a fresh capture.

The renewal-entry retry is required behavior, not an error fallback: some client states may dismiss the notification briefly without opening the TOTP challenge. Do not ask the user to click it manually before the retry cap is exhausted.

### 3. If direct renewal fails, toggle the existing connection once

Use this fallback only after the direct-renewal retry cap is exhausted and no TOTP challenge exists in any visible SecureLink window.

1. Rerun `status` and capture every visible window.
2. Identify the regular workbench and visually require its connection control to say exactly `Connected` / `已连接`. It may disagree with the sanitized backend state after forced expiry; the visible control determines whether the first toggle is safe.
3. Revalidate geometry and click that exact control once:

```bash
"$SKILL/scripts/securelink.sh" click-connect WORKBENCH_HANDLE X Y WIDTH HEIGHT disconnect --dry-run
"$SKILL/scripts/securelink.sh" click-connect WORKBENCH_HANDLE X Y WIDTH HEIGHT disconnect
```

4. Use read-only polling and fresh captures until the same workbench visibly says `Disconnected` / `未连接`. Do not click again while it transitions. Stop if it does not become disconnected within 10 seconds.
5. Recapture the workbench, recompute the center of the exact `Connect` / `连接` control, and click it once:

```bash
"$SKILL/scripts/securelink.sh" click-connect WORKBENCH_HANDLE X Y WIDTH HEIGHT connect --dry-run
"$SKILL/scripts/securelink.sh" click-connect WORKBENCH_HANDLE X Y WIDTH HEIGHT connect
```

6. For up to 10 seconds, repeatedly enumerate and capture every visible SecureLink window. The expected result is the renewal TOTP challenge. Do not click `Connect` a second time. If no challenge appears, stop and report that SecureLink failed to enter authentication.

This fallback intentionally causes a short VPN interruption. Never use it when the workbench state is ambiguous or when the visible action is login, logout, reset, or account selection.

Once the TOTP window appears, capture it and visually require all of:

- a renewal-triggered MFA/TOTP challenge;
- a six-digit TOTP input;
- a button labeled `继续` or `Continue`;
- no login, logout, password-change, TOTP-bind, or active TOTP-reset workflow.

The standard SecureLink MFA dialog may include a passive `Reset TOTP Key` link beside the normal six-digit challenge. Its presence does not make the challenge unsafe and must not block renewal. Never click or focus that link. Stop only if the UI has actually navigated into reset or binding, such as showing a QR code, secret key, confirmation form, or reset-specific instructions instead of the ordinary six-digit challenge.

If any condition is uncertain, stop without clicking. Read [references/ui-markers.md](references/ui-markers.md) when distinguishing renewal from unsafe authentication screens.

The post-click window may change from a narrow notification to a regular workbench-sized SecureLink window. This size transition is expected. Always use the new capture's geometry for the input and Continue coordinates; never reuse the notification geometry or record host-observed dimensions as policy.

### 4. Arm first, request the code last

Identify the TOTP input and Continue coordinates relative to the latest capture. Also record a tight rectangle around only the TOTP input positions, including their focus border; it must exclude all labels, instructions, reset/bind navigation, and the Continue control. Start the one-shot submitter with that same visually inspected capture and a short wait, using `tty: true`:

```bash
"$SKILL/scripts/securelink.sh" arm-submit TOTP_WINDOW_HANDLE VERIFIED_CAPTURE.png INPUT_LEFT INPUT_TOP INPUT_WIDTH INPUT_HEIGHT INPUT_X INPUT_Y SUBMIT_X SUBMIT_Y WIDTH HEIGHT 45
```

The wrapper refuses a real submission without a TTY or without a managed private capture. Its preflight derives the baseline directly from the visually inspected PNG and requires a new in-memory full-window capture to match it pixel-for-pixel. It then saves the TTY settings, disables echo, prints `SECURELINK_SUBMITTER_ARMED`, and waits in Bash for one line. After input it immediately restores the TTY and feeds the validated code to PowerShell through anonymous stdin; the code is never an OS process argument. Immediately before input, PowerShell again requires an exact full-window match, so no digit or click is sent after same-window navigation. After typing, it permits pixel changes only inside the supplied tight TOTP-input rectangle and rechecks every pixel outside it before clicking Continue. The fingerprints are one-way, ephemeral, non-secret values; no additional screenshots are stored. The process must remain running with a session ID after the armed marker. Only then tell the user the window is ready and request a newly generated six-digit code. Mention that chat itself may retain the message.

Do not replace this with a shell `read`, a temporary file, a named command argument, an environment variable, or a TTY whose echo has not been disabled. If the process exits before a code arrives, arm a new submitter; never reuse the previous channel.

On receipt, reject anything except exactly six ASCII digits. Send the code plus a newline to the existing process using `write_stdin`. Do not include the code in commentary or the final response. The submitter focuses the verified window, types without the clipboard, clicks Continue once, clears its local character buffer, and exits.

### 5. Verify, clean up, and retry safely

Poll `status` for up to 20 seconds. Success requires:

- VPN state remains `connected`; and
- remaining validity increases to a fresh value consistent with the client or administrator policy, or the SecureLink log reports renewal success after submission.

Do not rely on a toast alone. If the code is rejected or expired, report it without quoting the code, recapture the still-open challenge, arm a new submitter, and request a new code. Never replay the old one.

Delete each managed temporary screenshot with `securelink.sh cleanup CAPTURE.png` immediately after its final use and again on every terminal path. They may contain account or network details. Do not read or expose general SecureLink logs; `status` intentionally emits only sanitized state and timing fields.
