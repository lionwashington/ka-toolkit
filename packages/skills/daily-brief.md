---
name: daily-brief
description: Generate a daily briefing with weather, calendar, todos, emails, market data, news, and health reminders. Use when the user asks for a daily report, morning brief, or says "日报" or "早报".
user-invocable: true
---

# Daily Brief

Generate a comprehensive daily briefing by pulling data from multiple sources.

## Data Sources

Collect data in parallel where possible:

### 1. Weather

⚠️ **HARDRULE — must run every time; never skip / never take a shortcut via conversation history**:

**Step 1 (mandatory)**: use the Read tool to read `<your-workspace>/USER.md`
**Step 2 (mandatory)**: extract the `Location:` field from that file (this is the user's current address, the authoritative source)
**Step 3**: use the city name extracted in Step 2 to call amap weather / web search for today's weather
**Step 4**: output the weather — temperature range, conditions, wind, rain/snow forecast

❌ **Forbidden**:
- Do not use a city name from a previous daily brief in conversation history (it may be stale / wrong)
- Do not use a city name based on inference or impression
- Do not skip Steps 1-2 and just use amap's default parameters

📌 **Lesson learned**: the daily brief once used the wrong city for 14 days in a row — a college name mentioned in conversation (actually a school in a different region) was mistaken for the user's city, causing the weather to be wrong the whole time. Root cause = trusting a second-hand place name from conversation history without checking the authoritative source. Fix = mandatory Step 1 read USER.md for the place of residence, no longer trusting second-hand data from conversation history.

### 2. Calendar
Run `gog auth list` to find accounts, then for the calendar account:
```bash
gog -a <calendar_account> calendar events list --cal <calendar_account> --from <today> --to <tomorrow>
```
Show: time, title, location. Highlight conflicts.

### 3. Todos
Use the `kb_read_topic` MCP tool to read the "todo" topic (or similar). Extract active/urgent items.

### 4. Email

**Scope of important emails**: check the **emails from the last 3 days** (not just today / not just unread), and **proactively filter out the important ones** — not a simple unread count.

For each email account from `gog auth list`:
```bash
gog -a <account> gmail search "newer_than:3d" --json
```

Then **proactively filter for important** (not just highlight):
- Important senders: lawyer / boss / school / bank / government agency / regulator / important events on investment platforms
- Important keywords: contract / deadline / urgent / action required / notice / payment / offer / inquiry / application / appointment
- **Skip**: marketing / promotions / notifications (e.g. Postman / Kraken marketing / Facebook recommendations / Schwab eStatement notifications)

Output format: for each account, list 1-3 "important" emails (with sender + subject + a short content judgment); if there are no important ones, explicitly say "none important". **Do not list the unread count number** — unless there's a genuinely important actionable.

### 5. Market
Use the `market-data` MCP tools (`crypto_price`, `crypto_prices`, `stock_quote`, `stock_quotes`) for real-time prices.
- Check knowledge base (topics/finance.md or similar) for which assets the user tracks
- Use `crypto_prices` for crypto (e.g. ids: "bitcoin,ethereum,solana")
- Use `stock_quotes` for stocks/indices (e.g. symbols: "SPY,QQQ,NVDA")
- Fall back to web search only if MCP tools are unavailable
- Show: price, daily change %

### 6. News
Search the web for top headlines:
- International news (2-3 items)
- Domestic news relevant to user's location (1-2 items)
- Industry news if known from user profile (1-2 items)

### 7. Health Reminders
Use the `kb_read_topic` MCP tool to read the "health" topic. Extract:
- Upcoming medical appointments
- Medication reminders
- Scheduled checkups
- Exercise streak / gap tracking

## Output Format

```
🌅 Daily Brief — YYYY-MM-DD Day-of-Week

━━━━━━━━━━━━━━━━

🌤 Weather (City)
<conditions, temperature range, alerts>

━━━━━━━━━━━━━━━━

📅 Today's Schedule
<events with times, or "No events today">

━━━━━━━━━━━━━━━━

📋 Todos
🔴 <urgent items>
🟡 <in-progress items>

━━━━━━━━━━━━━━━━

📧 Email
<unread count per account, important highlights>

━━━━━━━━━━━━━━━━

📊 Market
<asset prices and changes>

━━━━━━━━━━━━━━━━

🌍 News
<top headlines>

━━━━━━━━━━━━━━━━

💊 Health Reminders
<appointments, medications, exercise status>

━━━━━━━━━━━━━━━━
```

## Delivery

- If running from Telegram: send the brief via the Telegram reply tool
- If running from terminal: output directly
- Keep it concise — each section should be scannable in seconds

## Error Handling

If a data source fails (e.g. gogcli not configured, no internet):
- Skip that section with a brief note: "📧 Email — (gogcli not configured)"
- Don't let one failure block the entire brief

## Notes

- Use the user's timezone (check USER.md or system time)
- Adapt content to what's actually configured — if no finance topic exists, skip market section
- Don't repeat yesterday's brief content — focus on what's new
