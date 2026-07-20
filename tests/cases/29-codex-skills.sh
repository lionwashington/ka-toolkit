#!/bin/bash
set -euo pipefail

REPO="${REPO:-/repo}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HOME="$TMP/home" KA_HOME="$TMP/runtime" \
KA_CLAUDE_SKILLS="$TMP/claude-skills" KA_CODEX_SKILLS="$TMP/codex-skills" \
  bash "$REPO/install.sh" --only skills --switch >/dev/null

[ -L "$TMP/claude-skills/daily-brief/SKILL.md" ] || { echo "FAIL: Claude daily-brief file link missing"; exit 1; }
[ -L "$TMP/claude-skills/kb/SKILL.md" ] || { echo "FAIL: Claude kb file link missing"; exit 1; }

for skill in daily-brief kb; do
  [ -L "$TMP/codex-skills/$skill" ] || { echo "FAIL: Codex $skill directory link missing"; exit 1; }
  [ -f "$TMP/codex-skills/$skill/SKILL.md" ] || { echo "FAIL: broken Codex $skill directory link"; exit 1; }
done

# Upgrade the old, undiscoverable Codex layout (real directory + linked file).
rm "$TMP/codex-skills/daily-brief"
mkdir "$TMP/codex-skills/daily-brief"
ln -s "$TMP/runtime/kb/skills/daily-brief/SKILL.md" "$TMP/codex-skills/daily-brief/SKILL.md"
HOME="$TMP/home" KA_HOME="$TMP/runtime" \
KA_CLAUDE_SKILLS="$TMP/claude-skills" KA_CODEX_SKILLS="$TMP/codex-skills" \
  bash "$REPO/install.sh" --only skills --switch >/dev/null
[ -L "$TMP/codex-skills/daily-brief" ] || { echo "FAIL: old Codex file-link layout was not migrated"; exit 1; }

echo "29-codex-skills OK"
