---
name: calendar
description: View, create, and manage Google Calendar events via gogcli. Use when the user asks about schedule, appointments, or wants to add/modify events.
user-invocable: true
---

# Calendar Manager

Manage Google Calendar using `gog` CLI.

## Account

Check which account has calendar access by running `gog auth list` and consulting the knowledge base `topics/tools.md` for account roles. Use the account configured for calendar (typically the primary account).

## Commands

Parse the user's input after `/calendar` to determine the action:

### `/calendar` or `/calendar today`
Show today's events:
```bash
gog -a <account> calendar events list --cal <account> --from <today_YYYY-MM-DD> --to <tomorrow_YYYY-MM-DD>
```
Calculate actual dates from the system clock.

### `/calendar tomorrow`
Show tomorrow's events:
```bash
gog -a <account> calendar events list --cal <account> --from <tomorrow_YYYY-MM-DD> --to <day_after_tomorrow_YYYY-MM-DD>
```
Calculate actual dates from the system clock.

### `/calendar week`
Show this week's events:
```bash
gog -a <account> calendar events list --cal <account> --from <today_YYYY-MM-DD> --to <7_days_later_YYYY-MM-DD>
```
Calculate actual dates from the system clock.

### `/calendar date <YYYY-MM-DD>`
Show events for a specific date.

### `/calendar add <title> <time>`
Create a new event. Parse the title and time from user input. Confirm before creating:
```bash
gog -a <account> calendar create <account> --summary "<title>" --from "<start_time>" --to "<end_time>"
```
If the user only gives a start time, default to 1 hour duration.
**Always confirm with the user before creating.**

### `/calendar delete <event_id>`
Delete an event. Confirm before deleting:
```bash
gog -a <account> calendar delete <account> <event_id>
```
**Always confirm with the user before deleting.**

## Notes
- Use actual dates (YYYY-MM-DD) for --from and --to, not relative expressions
- Calendar ID is typically the account email (e.g. from `gog calendar calendars`)
- When showing events, display: time, title, location (if any)
- Highlight time conflicts (overlapping events)
- If running from Telegram, keep responses concise
- Today's date can be determined from the system
