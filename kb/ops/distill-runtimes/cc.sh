#!/bin/bash
# Claude Code executor for headless KB distillation.

distill_runtime_run() {
    local prompt="$1" output_file="$2" log_file="$3"
    local model="${KA_DISTILL_MODEL:-claude-opus-4-8}"
    claude -p "$prompt" \
        --model "$model" \
        --permission-mode bypassPermissions \
        --setting-sources user \
        --no-session-persistence \
        --output-format json \
        > "$output_file" 2>> "$log_file"
}

# Claude Code 2.1.x can intermittently return a 400 when replaying thinking
# blocks. A fresh no-persistence invocation is safe to retry.
distill_runtime_is_retriable() {
    local output_file="$1"
    node -e '
const fs = require("fs");
let txt = "";
try { txt = fs.readFileSync(process.argv[1], "utf-8"); } catch { process.exit(1); }
let obj = null;
for (const line of txt.split("\n")) {
  const t = line.trim();
  if (!t.startsWith("{")) continue;
  try { const o = JSON.parse(t); if (o && o.type === "result") obj = o; } catch {}
}
if (!obj) process.exit(1);
const result = typeof obj.result === "string" ? obj.result : "";
process.exit(obj.is_error === true && obj.api_error_status === 400 && /thinking|redacted_thinking/i.test(result) ? 0 : 1);
' "$output_file"
}
