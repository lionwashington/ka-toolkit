#!/bin/bash
set -euo pipefail

REPO="${REPO:-/repo}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HOME="$TMP/home" KA_HOME="$TMP/runtime" \
KA_CLAUDE_SKILLS="$TMP/claude-skills" KA_CODEX_SKILLS="$TMP/codex-skills" \
KA_SKIP_SKILL_DEPS=1 \
  bash "$REPO/install.sh" --only skills --switch >/dev/null

[ -L "$TMP/claude-skills/daily-brief/SKILL.md" ] || { echo "FAIL: Claude daily-brief file link missing"; exit 1; }
[ -L "$TMP/claude-skills/kb/SKILL.md" ] || { echo "FAIL: Claude kb file link missing"; exit 1; }
[ -L "$TMP/claude-skills/coros-health" ] || { echo "FAIL: Claude coros-health directory link missing"; exit 1; }
[ -f "$TMP/claude-skills/coros-health/SKILL.md" ] || { echo "FAIL: broken Claude coros-health directory link"; exit 1; }
[ -f "$TMP/runtime/kb/skills/coros-health/scripts/coros-health.mjs" ] || { echo "FAIL: coros-health script was not deployed"; exit 1; }
[ -x "$TMP/runtime/kb/skills/securelink-renewal/scripts/securelink.sh" ] || { echo "FAIL: securelink-renewal wrapper was not deployed as executable"; exit 1; }
[ -f "$TMP/runtime/kb/skills/securelink-renewal/references/ui-markers.md" ] || { echo "FAIL: securelink-renewal reference was not deployed"; exit 1; }

for skill in daily-brief kb coros-health securelink-renewal; do
  [ -L "$TMP/codex-skills/$skill" ] || { echo "FAIL: Codex $skill directory link missing"; exit 1; }
  [ -f "$TMP/codex-skills/$skill/SKILL.md" ] || { echo "FAIL: broken Codex $skill directory link"; exit 1; }
done

if find "$TMP/runtime/kb/skills/securelink-renewal" -type f \( -name '*.png' -o -name '*.log' -o -name '*.env' -o -iname '*secret*' \) | grep -q .; then
  echo "FAIL: securelink-renewal deployment contains runtime/private artifacts"
  exit 1
fi

# Upgrade the old, undiscoverable Codex layout (real directory + linked file).
rm "$TMP/codex-skills/daily-brief"
mkdir "$TMP/codex-skills/daily-brief"
ln -s "$TMP/runtime/kb/skills/daily-brief/SKILL.md" "$TMP/codex-skills/daily-brief/SKILL.md"
HOME="$TMP/home" KA_HOME="$TMP/runtime" \
KA_CLAUDE_SKILLS="$TMP/claude-skills" KA_CODEX_SKILLS="$TMP/codex-skills" \
KA_SKIP_SKILL_DEPS=1 \
  bash "$REPO/install.sh" --only skills --switch >/dev/null
[ -L "$TMP/codex-skills/daily-brief" ] || { echo "FAIL: old Codex file-link layout was not migrated"; exit 1; }

# A selective production-style install creates missing discovery roots and must
# not activate unrelated skills.
HOME="$TMP/home" KA_HOME="$TMP/selective-runtime" \
KA_CLAUDE_SKILLS="$TMP/selective-claude" KA_CODEX_SKILLS="$TMP/selective-codex" \
KA_SKIP_SKILL_DEPS=1 \
  bash "$REPO/install.sh" --only skills --skill securelink-renewal --switch >/dev/null
[ -L "$TMP/selective-codex/securelink-renewal" ] || { echo "FAIL: selective SecureLink Codex link missing"; exit 1; }
[ ! -e "$TMP/selective-codex/coros-health" ] || { echo "FAIL: selective install activated COROS"; exit 1; }
[ ! -e "$TMP/selective-codex/nutrition-ledger" ] || { echo "FAIL: selective install activated nutrition"; exit 1; }

# A failed replacement must restore the original runtime and leave discovery
# valid; the following successful clean install then removes stale private data.
printf '%s\n' 'synthetic private runtime data' > "$TMP/selective-runtime/kb/skills/securelink-renewal/private.log"
if HOME="$TMP/home" KA_HOME="$TMP/selective-runtime" \
KA_CLAUDE_SKILLS="$TMP/selective-claude" KA_CODEX_SKILLS="$TMP/selective-codex" \
KA_SKIP_SKILL_DEPS=1 KA_TEST_FAIL_SKILL_SWAP_AFTER_BACKUP=securelink-renewal \
  bash "$REPO/install.sh" --only skills --skill securelink-renewal --switch >/dev/null 2>&1; then
  echo "FAIL: injected skill replacement failure unexpectedly succeeded"; exit 1
fi
[ -f "$TMP/selective-codex/securelink-renewal/SKILL.md" ] || {
  echo "FAIL: failed replacement left the discovery link broken"; exit 1
}
[ -f "$TMP/selective-runtime/kb/skills/securelink-renewal/private.log" ] || {
  echo "FAIL: failed replacement did not restore the original runtime"; exit 1
}

# Simulate crash leftovers; the next run must reconcile both before replacing.
mkdir "$TMP/selective-runtime/kb/skills/.securelink-renewal.stage.synthetic"
printf '%s\n' 'synthetic secret staging data' > "$TMP/selective-runtime/kb/skills/.securelink-renewal.stage.synthetic/private.log"
mkdir "$TMP/selective-runtime/kb/skills/.securelink-renewal.old.synthetic"
printf '%s\n' 'synthetic secret backup data' > "$TMP/selective-runtime/kb/skills/.securelink-renewal.old.synthetic/private.log"
HOME="$TMP/home" KA_HOME="$TMP/selective-runtime" \
KA_CLAUDE_SKILLS="$TMP/selective-claude" KA_CODEX_SKILLS="$TMP/selective-codex" \
KA_SKIP_SKILL_DEPS=1 \
  bash "$REPO/install.sh" --only skills --skill securelink-renewal --switch >/dev/null
[ ! -e "$TMP/selective-runtime/kb/skills/securelink-renewal/private.log" ] || {
  echo "FAIL: clean skill deployment retained a stale private artifact"
  exit 1
}
if find "$TMP/selective-runtime/kb/skills" -maxdepth 1 \( -name '.securelink-renewal.stage.*' -o -name '.securelink-renewal.old.*' \) | grep -q .; then
  echo "FAIL: interrupted skill-swap artifacts were not reconciled"
  exit 1
fi

# Missing or empty selectors must fail closed instead of deploying every skill.
if bash "$REPO/install.sh" --only skills --skill --switch --dry-run >/dev/null 2>&1; then
  echo "FAIL: --skill without a value did not fail closed"; exit 1
fi
if bash "$REPO/install.sh" --only skills --skill= --switch --dry-run >/dev/null 2>&1; then
  echo "FAIL: --skill= without a value did not fail closed"; exit 1
fi
if bash "$REPO/install.sh" --only --skill securelink-renewal --switch --dry-run >/dev/null 2>&1; then
  echo "FAIL: --only without a value did not fail closed"; exit 1
fi
if bash "$REPO/install.sh" --only= --skill securelink-renewal --switch --dry-run >/dev/null 2>&1; then
  echo "FAIL: --only= without a value did not fail closed"; exit 1
fi

# The screenshot wrapper owns path creation/lifecycle and rejects arbitrary
# output paths or cleanup targets before PowerShell can capture or overwrite.
: > "$TMP/outside.png"
if bash "$REPO/kb/skills/securelink-renewal/scripts/securelink.sh" capture 1 "$TMP/outside.png" >/dev/null 2>&1; then
  echo "FAIL: capture accepted a caller-selected path"; exit 1
fi
if bash "$REPO/kb/skills/securelink-renewal/scripts/securelink.sh" cleanup "$TMP/outside.png" >/dev/null 2>&1; then
  echo "FAIL: cleanup accepted a path outside the managed private lifecycle"; exit 1
fi

# On WSL, exercise the production fingerprint implementation with same-size
# synthetic images: central/outside changes fail closed, while only the tightly
# supplied input rectangle is excluded from the post-input comparison.
if command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
  powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$(wslpath -w "$REPO/tests/securelink-content-lock.ps1")" \
    -ModulePath "$(wslpath -w "$REPO/kb/skills/securelink-renewal/scripts/SecureLink.ContentLock.psm1")" \
    | grep -q 'SECURELINK_CONTENT_LOCK_TEST_OK' || {
      echo "FAIL: SecureLink content-lock mutation test failed"; exit 1
    }
fi

echo "29-codex-skills OK"
