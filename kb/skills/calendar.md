---
name: calendar
description: View, create, and manage Google Calendar events via gogcli. Use when the user asks about schedule, appointments, or wants to add/modify events.
user-invocable: true
---

# Calendar Manager

Manage Google Calendar using the `gogcli` executable.

## Runtime Setup

Before **every** non-interactive `gogcli` operation, load the optional
file-keyring environment in the **same shell invocation**. Never print the file
or either keyring variable:

```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input auth list
```

If the file is absent, continue normally because another keyring backend may be
configured. Do not export this environment globally into Workshop or cron.

## Account

Check which account has calendar access by running `gogcli auth list` with the
runtime setup above and consulting the knowledge base `topics/tools.md` for
account roles. Use the account configured for calendar (typically the primary
account).

## Commands

Parse the user's input after `/calendar` to determine the action:

### `/calendar` or `/calendar today`
Show today's events:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> calendar events --from <today_YYYY-MM-DD> --to <tomorrow_YYYY-MM-DD>
```
Calculate actual dates from the system clock.

### `/calendar tomorrow`
Show tomorrow's events:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> calendar events --from <tomorrow_YYYY-MM-DD> --to <day_after_tomorrow_YYYY-MM-DD>
```
Calculate actual dates from the system clock.

### `/calendar week`
Show this week's events:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> calendar events --from <today_YYYY-MM-DD> --to <7_days_later_YYYY-MM-DD>
```
Calculate actual dates from the system clock.

### `/calendar date <YYYY-MM-DD>`
Show events for a specific date.

### `/calendar add <title> <time>`
Create a new event. Parse the title and time from user input. Confirm before creating:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> calendar create <account> --summary "<title>" --from "<start_time>" --to "<end_time>"
```
If the user only gives a start time, default to 1 hour duration.
**Always confirm with the user before creating.**

### `/calendar update <event_id>`
Modify an existing event (time and/or title). Pass only the fields you want to change. Confirm before updating:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> calendar update <account> <event_id> --from "<start_time>" --to "<end_time>" --summary "<title>"
```
Times are RFC3339 with timezone (e.g. `2026-09-30T10:00:00+08:00`). Omit any flag you are not changing.
**Always confirm with the user before updating.**

### `/calendar delete <event_id>`
Delete an event. Confirm before deleting:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> calendar delete <account> <event_id> --force
```
**Always confirm with the user before deleting.**

## Notes
- Use actual dates (YYYY-MM-DD) for --from and --to, not relative expressions
- Calendar ID is typically the account email (e.g. from
  `gogcli calendar calendars`)
- When showing events, display: time, title, location (if any)
- Highlight time conflicts (overlapping events)
- If running from Telegram, keep responses concise
- Today's date can be determined from the system
