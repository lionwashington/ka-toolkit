---
name: kb
description: Manage your personal knowledge base — search, browse topics, trigger distillation, and review topic suggestions
---

# Knowledge Base Manager

You are managing the user's personal knowledge base. Use the MCP tools available to you:

## Commands

Parse the user's input after `/kb` to determine the action:

### `/kb search <query>`
Use the `kb_search` MCP tool with the provided query. Present results in a readable format.

### `/kb topics`
Use the `kb_list_topics` MCP tool. Present all topics with descriptions.

### `/kb read <topic>`
Use the `kb_read_topic` MCP tool with the topic name. Display the full topic content.

### `/kb status`
Use the `kb_status` MCP tool. Show knowledge base statistics.

### `/kb distill` (defaults to `--background`)

Execute knowledge distillation on unprocessed conversations.

- **`/kb distill`** (no flag) and **`/kb distill --background`**: spawn the configured headless runtime (`distiller.runtime: cc|codex`) via `ka kb distill --background`. The current session returns immediately; the worker runs to completion in the background and writes `~/.knowledge-assistant/state/distill-current.json`. The worker holds **no Telegram token and never pushes** — Telegram has a single egress, the main session. On failure the worker writes a standalone sentinel `~/.knowledge-assistant/state/distill-last-failure.json` (with `failed_at` / `exit_code` / `attempts` / `snapshot_offset` / `error_excerpt` / `log_path` / `acked:false`) that the next run does NOT overwrite. Use this 99% of the time.
- **`/kb distill --foreground`**: run the workflow synchronously in the current session (blocks). Useful for debugging, when the background runner is broken, or when you specifically need the result inline.

#### Background mode (default)

1. Spawn `ka kb distill --background`. The KB launcher resolves the canonical main transcript for the configured runtime and current workspace; do not guess a transcript by global modification time.
2. For an explicit recovery/debug run only, pass `--jsonl <abs-path> --session-id <id>`.
3. Capture the one-line stdout (`distill-bg: pid=N log=PATH status=STATEFILE snapshot=BYTES`) and surface it to the user.
4. Done — do NOT execute Phase 0/1 yourself; the worker process handles them.
5. If `ka kb distill --background` exits non-zero, fall back to the foreground workflow below (rare path; usually means jsonl missing or another worker already running).

To inspect a running or finished worker later, use `ka kb distill status` (or `ka kb distill status --json` for machine-readable output). On startup, sessions should run `ka kb distill status` once and surface any `failed` or recent `done` state to the user so background runs aren't invisible.

**Main-side failure notification contract (the single Telegram egress).** Because the background worker never touches Telegram, the main session is responsible for notifying the user of background-distill failures. On startup AND at the start of every `/kb distill`, the main session must:
1. Read `~/.knowledge-assistant/state/distill-last-failure.json` if it exists.
2. If `acked` is `false`, Telegram-push the failure to the user (include `error_excerpt`, `exit_code`, `attempts`, and `log_path`).
3. After pushing, set `acked: true` in that same file (the `acked` flag is the watermark that prevents re-notifying the same failure). The worker only ever rewrites this file on a *new* failure (resetting `acked` to false); it never flips it back to false otherwise.

#### Foreground mode (`--foreground`)

**Workflow:**

**Phase 0 — Capture current session to raw/ (incremental)**
1. Find the current runtime's canonical transcript: Claude Code uses its project JSONL; Codex uses the canonical thread rollout under `$CODEX_HOME/sessions`. Never select the newest transcript across unrelated working directories.
2. Check if this session is already captured in `raw/` (by matching `session_id` in frontmatter).
3. **Always use the `ka-jsonl-reader` CLI** to extract messages — do NOT read the jsonl yourself (jsonl can reach 50MB+ and re-reading wastes tokens; the CLI does incremental seek-read in Node).

   Run the CLI:

   ```bash
   node "$HOME/.knowledge-assistant/kb/core/dist/<runtime-reader-cli>.js" \
     --jsonl <abs-path-to-jsonl> \
     [--offset <last_parsed_offset>] \
     [--last-entry-uuid <last_parsed_message_id>] \
     [--message-count <last_parsed_message_count>] \
     [--batch <N>]
   ```

   - **First capture** (no existing raw file): omit `--offset` / `--last-entry-uuid` / `--message-count`. CLI does a full scan.
   - **Update existing raw**: read the existing raw frontmatter, pass the 4 fields `last_parsed_offset` / `last_parsed_message_id` / `last_parsed_message_count` / and an incrementing `--batch` value (= prior batch + 1). The CLI seeks to the offset, validates against the uuid sentinel, and returns only the delta.
   - **Lazy migrate**: if existing raw has no `last_parsed_*` fields (legacy file), treat as first capture — the CLI will full-scan and the new fields will be written.

   CLI output (stdout, JSON):
   ```json
   {
     "progress": { "offset": <bytes>, "lastEntryUuid": "<uuid>", "messageCount": <n>, "parsedAt": "<iso>" },
     "markdownDelta": "<!-- batch N @ <iso> -->\n\n## User\n\n...\n\n## Assistant\n\n...",
     "fellBack": false,
     "reason": null,
     "deltaCount": <n>
   }
   ```

   - `fellBack: true` with `reason: "truncation" | "sentinel-not-found"` indicates the jsonl was rewritten (Claude Code context compaction or `/clear`). The `markdownDelta` then contains a full re-scan of the file; the raw markdown body should be **fully replaced** rather than appended. The separator comment will read `(full re-scan after fallback)`.
   - `fellBack: false` with `deltaCount > 0`: append `markdownDelta` to the end of the existing raw markdown body.
   - `deltaCount: 0`: no new messages; still update `last_parsed_offset` / `last_parsed_at` to reflect that the CLI has been run, but no body change.

4. Save / update `raw/YYYY-MM-DD-<id>.md`:

   ```yaml
   ---
   id: <8-char hex>
   source: <claude-code|codex>
   session_id: <session uuid>
   timestamp: <ISO>
   distilled: false
   topics: []
   last_parsed_offset: <progress.offset>
   last_parsed_message_id: <progress.lastEntryUuid>
   last_parsed_message_count: <progress.messageCount>
   last_parsed_at: <progress.parsedAt>
   ---
   ```

   Body: append `markdownDelta` to existing body (or replace on fallback). Each batch is delimited by `<!-- batch N @ timestamp -->` for human review.

**Phase 1 — Process raw → conversations + topics**
5. Read the knowledge base config from `~/.knowledge-assistant/config/config.yaml`
6. Read all unprocessed raw files from `raw/` directory (files with `distilled: false` in frontmatter)
7. If no unprocessed content, report "Nothing to distill" and exit
8. Read existing topics via `kb_list_topics` MCP tool
9. For each unprocessed conversation, analyze its content and extract knowledge:
   - Match content to existing topics
   - For knowledge that fits an existing topic, append to that topic file with `[[wikilink]]` source reference
   - For knowledge needing a new topic, save to `pending-topics/` for user approval
10. Create or append to a daily summary in `conversations/YYYY-MM-DD.md`.

    **TL;DR protocol (mandatory)**: every daily log file **MUST** start with a `## TL;DR` section (after the frontmatter, before `# YYYY-MM-DD — <title>`). The TL;DR is strictly constrained: **≤10 lines / ≤500 characters**, containing 5 anchors:

    - **Core events**: the 1-2 key events of the day
    - **Anchor corrections**: key anchor updates (location / preference / decision / data correction)
    - **Lessons**: lessons learned or rule violations (if any)
    - **Numeric anchors**: amounts / times / key data points
    - **Carry-over**: actionable items to follow up on tomorrow

    Full template:

    ```markdown
    ---
    title: YYYY-MM-DD daily
    date: YYYY-MM-DD
    tags:
      - daily
    ---

    ## TL;DR

    - **Core events**: ...
    - **Anchor corrections**: ...
    - **Lessons**: ...
    - **Numeric anchors**: ...
    - **Carry-over**: ...

    ---

    # YYYY-MM-DD — <one-line title>

    ## Thread 1: ...   # the daily-log-splitter CLI matches this literal heading; the legacy Chinese `## 主线 N:` is still recognized too

    (detailed conversation content)

    ## Thread 2: ...
    ```

    **When creating a new daily log**: follow the template above; all 5 TL;DR items are required.
    **When appending to an existing daily log**: update the existing TL;DR (merge all of the day's events; do not append a second TL;DR section).

    Reference live samples: the TL;DR at the top of `conversations/2026-05-24.md` and `conversations/2026-05-25.md`.

    After the TL;DR, write the full content, using `## Thread N:` headings to divide the core topics, including key decisions, verbatim user quotes, timestamps, lesson anchors, etc. (The legacy Chinese `## 主线 N:` is still matched by the splitter, so older logs keep working.)
11. **Auto-split when daily log exceeds 1000 lines**. After writing/appending to `conversations/YYYY-MM-DD.md`, run the splitter CLI:

    ```bash
    node "$HOME/.knowledge-assistant/kb/core/dist/daily-log-splitter-cli.js" \
      --file <abs path to YYYY-MM-DD.md> [--threshold 1000]
    ```

    Behaviour:
    - `wc -l ≤ threshold` → returns `{"split": false, "reason": "under-threshold"}` and no files are touched.
    - `wc -l > threshold` → finds the last `## Thread N:` heading (legacy `## 主线 N:` also matched) at or before the threshold and moves everything from that heading to EOF into `conversations/YYYY-MM-DD-part2.md` (auto-incremented if `part2` already exists). The main file keeps the TL;DR and gets a `→ continued [[YYYY-MM-DD-partN]]` trailing cross-link.
    - If the new part still exceeds the threshold, the splitter chains automatically (`partN+1`) up to 5 levels deep. Each part links back to its immediate parent and the main file.
    - If no `## Thread N:` (or legacy `## 主线 N:`) heading is found within the threshold window, the splitter falls back to a hard cut at line N and reports `reason: "no-boundary-found"`.

    Idempotent: re-running the CLI on an already-small file is a no-op. TL;DR is preserved only in the main file; part files include a `← [[YYYY-MM-DD]] (main file has TL;DR)` back-link.

12. Update each raw file's frontmatter: set `distilled: true` and list matched topics
13. Report: how many conversations processed, which topics updated, any new topic suggestions, and any part-split actions (e.g. "2026-05-26 daily split into part1+part2 at line 612").

**Important:** You (the terminal tool) ARE the LLM. Read the conversations, understand the content, and write the distilled knowledge directly. Do not call any external API.
**Note:** Raw transcripts are in `raw/`. Daily summaries go to `conversations/`. Topics go to `topics/`.

### `/kb suggest-topic`
Read the `pending-topics/` directory in the knowledge base and present any suggested topics for the user to approve or reject.

### `/kb approve-topic <name>`
Move the specified topic from `pending-topics/` to `topics/`, add it to the INDEX, and confirm to the user.

### `/kb pause`
Pause conversation capture and distillation for the current session. Creates a flag file at `~/.knowledge-assistant/state/paused`. While paused, the Stop hook will skip capturing this conversation.

Run: `mkdir -p ~/.knowledge-assistant/state && touch ~/.knowledge-assistant/state/paused`

Report: "Knowledge capture paused. This conversation will not be saved or distilled. Run `/kb resume` to re-enable."

### `/kb resume`
Resume conversation capture after a pause. Removes the flag file.

Run: `rm -f ~/.knowledge-assistant/state/paused`

Report: "Knowledge capture resumed. Conversations will be captured and distilled normally."

### `/kb config`
Read and display the current configuration from `~/.knowledge-assistant/config.yaml`.

### `/kb` (no args)
Show a brief help message listing all available subcommands.
