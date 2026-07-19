#!/bin/bash
# Codex CLI executor for ephemeral, headless KB distillation.

distill_runtime_run() {
    local prompt="$1" output_file="$2" log_file="$3"
    local -a args=(exec --json --ephemeral --skip-git-repo-check --sandbox workspace-write)
    if [ -n "${KA_CODEX_DISTILL_MODEL:-}" ]; then
        args+=(--model "$KA_CODEX_DISTILL_MODEL")
    fi
    args+=("$prompt")
    codex "${args[@]}" > "$output_file" 2>> "$log_file"
}

# Retry only transport/service failures. Model, sandbox, tool, and prompt
# failures require inspection and must not silently burn repeated runs.
distill_runtime_is_retriable() {
    local output_file="$1"
    node -e '
const fs = require("fs");
let text = "";
try { text = fs.readFileSync(process.argv[1], "utf8"); } catch { process.exit(1); }
let transient = false;
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (event.type !== "error" && event.type !== "turn.failed") continue;
    const message = JSON.stringify(event);
    if (/rate.?limit|server overloaded|temporar|timed? out|connection reset|service unavailable/i.test(message)) transient = true;
  } catch {}
}
process.exit(transient ? 0 : 1);
' "$output_file"
}
