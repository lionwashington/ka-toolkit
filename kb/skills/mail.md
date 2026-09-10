---
name: mail
description: Check, search, and send emails via gogcli. Use when the user asks about emails, inbox, or wants to send/reply to messages.
user-invocable: true
---

# Email Manager

Manage emails across multiple Google accounts using the `gogcli` executable.

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

## Accounts

Look up configured accounts by running:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input auth list
```

If the knowledge base has a `topics/tools.md` file, check the "Google Suite" section for account roles (which accounts are for mail, which for calendar).

If no account info is available, use the first account returned by
`gogcli auth list` as default.

## Commands

Parse the user's input after `/mail` to determine the action:

### `/mail` or `/mail check`
Check unread emails across all configured accounts. For each account from
`gogcli auth list`, run:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> gmail search "is:unread" --json | head -50
```
Present a summary: sender, subject, date. Group by account.

### `/mail search <query>`
Search emails. Run:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> gmail search "<query>" --json
```
If the user specifies an account, use that account. Otherwise search the default.

### `/mail read <message_id>`
Read a specific email by ID. Run:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> gmail messages get <message_id> --json
```

### `/mail send <to> <subject>`
Compose and send an email. Ask the user for the body content, then confirm before sending:
```bash
GOGCLI_KEYRING_ENV="${GOGCLI_KEYRING_ENV:-$HOME/.config/gogcli/keyring-env.zsh}"
[ ! -r "$GOGCLI_KEYRING_ENV" ] || . "$GOGCLI_KEYRING_ENV"
gogcli --no-input -a <account> gmail send --to "<to>" --subject "<subject>" --body "<body>"
```
**Always confirm with the user before sending.**

### `/mail reply <message_id>`
Reply to an email. Read the original first, ask the user for reply content, confirm, then send.

### `/mail digest`
Generate a digest of today's important emails across all accounts. Summarize key emails by sender and topic.

## Notes
- Use `--json` for structured output, parse and present in readable format
- For long email lists, show top 10 and ask if the user wants more
- When presenting emails, show: From, Subject, Date, and a brief snippet
- If running from Telegram, keep responses concise
