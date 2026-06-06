---
name: pane
description: Inspect or unstick another workshop CC pane via tmux — use when a mate/CC isn't responding on the channel, seems hung, or you need to see what another pane is actually doing. Out-of-band fallback for when SendMessage/the channel can't reach a pane.
user-invocable: true
---

# Workshop pane peek / poke

Out-of-band tmux access to another CC's pane, for when the **channel can't reach it**
(a hung or unresponsive CC). Normal CC↔CC comms stay on the channel (`SendMessage` /
`send_to_channel`) — this is the fallback, not the default.

Two commands (run via Bash):

## `ka workshop peek <name> [lines]` — READ (always safe)

Capture-pane: print the live screen of the pane whose channel is `<name>` (e.g. `main`,
`story-maker`), last `[lines]` (default 60). Use it to **see what a CC is actually doing**:
- A mate went quiet on the channel → `ka workshop peek <name>` to see if it's working,
  waiting on a prompt, errored, or hung.
- Diagnose the `could not be parsed (retry also failed)` / stuck-mid-turn state.

```bash
ka workshop peek main          # last 60 lines of main's pane
ka workshop peek story-maker 120
```

## `ka workshop poke <name> <keys…>` — WRITE (deliberate recovery only)

Send-keys into the pane. This is **typing for the other CC** — only do it to **unstick a
genuinely hung pane**, never for routine messaging (use the channel). Everything after
`<name>` goes straight to `tmux send-keys`, so key names and literal text both work:

```bash
ka workshop poke main Enter           # nudge a CC stuck waiting to submit
ka workshop poke main Escape          # cancel a stuck prompt / close a panel
ka workshop poke main C-c             # interrupt a runaway
ka workshop poke main /clear Enter    # send a slash command + submit
ka workshop poke main /usage Enter    # open a full-screen panel — MUST Esc after (see below)
```

### Safety rules
- **`peek` first, always.** Look before you poke — confirm it's actually hung and see what
  state it's in. Never poke blind.
- **Never poke a CC that's mid-generation / actively working** — you'll corrupt its input or
  interrupt real work. Poke only when `peek` shows it idle-but-stuck or frozen.
- **Close any full-screen panel you open.** Interactive slash commands like `/usage`, `/help`,
  `/config` open a modal overlay (look for `Esc to cancel` at the bottom) that **blocks the
  CC's input box** — while it's up the CC can't see or process incoming channel messages and
  looks "hung / not replying". After `peek`-reading the panel, **always `poke <name> Escape`**
  to close it and return the CC to its prompt. (`/context` prints inline and does NOT need
  this; `/usage` does. When unsure, `peek` for an `Esc to cancel` footer.)
- **Don't use poke for comms.** Messages go through the channel; poke is for recovery only.
- Prefer the gentlest nudge first (`Enter`, then `Escape`, then `C-c`).
- `<name>` is a channel name (or a raw `session:window.pane` target). Unknown name → the
  command lists the online channels.
