#!/bin/bash
# Automatically back up a workspace to GitHub.
# Scheduled by ka cron (job: workspace-backup, runs daily at 03:00).
#
# Override REPO_DIR to point at the workspace you want backed up.

set -e

REPO_DIR="${REPO_DIR:-$HOME/workspace/your-workspace}"
LOG_FILE="$HOME/.knowledge-assistant/state/workspace-backup.log"
mkdir -p "$(dirname "$LOG_FILE")"

cd "$REPO_DIR"

# Check for any changes (staged / unstaged / untracked).
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "$(date -Iseconds) [workspace-backup] No changes to commit" >> "$LOG_FILE"
  exit 0
fi

# If there are changes, commit + push.
git add -A
git commit -m "chore: auto backup $(date +%Y-%m-%d_%H:%M)"
git push origin master

echo "$(date -Iseconds) [workspace-backup] Pushed to GitHub" >> "$LOG_FILE"
