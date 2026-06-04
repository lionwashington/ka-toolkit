---
name: mail
description: Check, search, and send emails via gogcli. Use when the user asks about emails, inbox, or wants to send/reply to messages.
user-invocable: true
---

# Email Manager

Manage emails across multiple Google accounts using `gog` CLI.

## Accounts

Look up configured accounts by running:
```bash
gog auth list
```

If the knowledge base has a `topics/tools.md` file, check the "Google Suite" section for account roles (which accounts are for mail, which for calendar).

If no account info is available, use the first account returned by `gog auth list` as default.

## Commands

Parse the user's input after `/mail` to determine the action:

### `/mail` or `/mail check`
Check unread emails across all configured accounts. For each account from `gog auth list`, run:
```bash
gog -a <account> gmail search "is:unread" --json | head -50
```
Present a summary: sender, subject, date. Group by account.

### `/mail search <query>`
Search emails. Run:
```bash
gog -a <account> gmail search "<query>" --json
```
If the user specifies an account, use that account. Otherwise search the default.

### `/mail read <message_id>`
Read a specific email by ID. Run:
```bash
gog -a <account> gmail messages get <message_id> --json
```

### `/mail send <to> <subject>`
Compose and send an email. Ask the user for the body content, then confirm before sending:
```bash
gog -a <account> gmail send --to "<to>" --subject "<subject>" --body "<body>"
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
