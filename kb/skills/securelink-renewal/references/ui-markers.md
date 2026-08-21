# SecureLink renewal markers

Use this reference only when deciding whether the current SecureLink window is safe for renewal.

## Safe renewal markers

- Entry action: `立即续期` / `Renew now`
- Connected workbench state: `已连接` / `Connected`; only this exact state permits the fallback disconnect click.
- Disconnected workbench state and action: `未连接` / `Disconnected` with `连接` / `Connect`; only this exact state permits the fallback connect click.
- Forced-renewal title: `SDP Connection Notification` / `SDP连接通知`
- Forced-renewal body: the configured forced-disconnection time has been reached and the user must renew before using the connection again.
- Success text: `续期成功，已为您更新连接时长` / `Renewal successful, connection duration has been updated for you`
- The normal workbench log route contains `/mainWindow/main/workbench/main`.
- A successful connection emits `update vpn state: connected` and `state: CONNECTED`.
- A successful renewal increases remaining validity to a fresh value consistent with the client or administrator policy; never hardcode a duration.

`idle` is expected after the forced-disconnection timer reaches zero when the exact renewal notification is visible. Missing remaining minutes is also expected at that point. A narrow full-height panel is a valid SecureLink notification layout, not an error by itself; dimensions are dynamic and must not be recorded as host policy.

The `Renew now` / `立即续期` action on this exact forced-renewal notification is idempotent. It may be clicked repeatedly when a fresh capture proves the identical notification remains or has returned. A brief disappearance followed by the same notification means the TOTP challenge did not open yet; recapture, recompute coordinates, and retry. Cap a single invocation at 10 entry clicks or 30 seconds. This exception never applies to Continue, login, logout, reset, or TOTP submission.

If that cap is exhausted without a TOTP challenge, the normal workbench may still visually show `Connected` even when the sanitized backend state is `idle`. The renewal fallback is to click that exact `Connected` control once, wait until the workbench visibly becomes `Disconnected`, then click the exact `Connect` control once. A TOTP challenge should then appear. Enumerate and inspect every SecureLink top-level window after each transition because the notification, workbench, and challenge can be separate Electron windows.

## Expected challenge markers

- `多因子认证` / `TOTP认证` or equivalent MFA wording
- exactly six TOTP positions
- `继续` / `Continue`
- The ordinary challenge may also contain a passive `Reset TOTP Key` link. This link is allowed to remain visible but must never be clicked, focused, or used as a target.

## Stop markers

Stop without interaction if the screen contains any of these concepts, regardless of language:

- login or account selection;
- logout or exit;
- reset password or modify password;
- an active bind/reset TOTP workflow, indicated by a QR code, displayed or copyable secret key, reset confirmation form, or reset-specific instructions replacing the ordinary six-digit challenge;
- reset security key;
- organization or enterprise ID initialization;
- reinstall, repair, upgrade, or restart.

Do not treat generic `重新认证` / `Re-authenticate` as proof of renewal. It may be resource reauthentication rather than connection-validity renewal. The workflow must originate from `立即续期` / `Renew now`.

Do not stop merely because the standard six-digit MFA dialog contains an unselected `Reset TOTP Key` navigation link. Distinguish a passive link from having navigated into the reset flow.
