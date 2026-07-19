#!/bin/bash
# Runtime dispatch for headless KB distillation executors.

distill_runtime_load() {
    local runtime="${1:-cc}"
    local root="${KA_DISTILL_RUNTIMES_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
    local adapter="$root/$runtime.sh"
    if [ ! -f "$adapter" ]; then
        echo "distill_runtime_load: unknown runtime '$runtime'" >&2
        return 1
    fi
    # shellcheck disable=SC1090
    source "$adapter"
    declare -F distill_runtime_run >/dev/null 2>&1 || {
        echo "distill runtime '$runtime' does not implement distill_runtime_run" >&2
        return 1
    }
    declare -F distill_runtime_is_retriable >/dev/null 2>&1 || {
        echo "distill runtime '$runtime' does not implement distill_runtime_is_retriable" >&2
        return 1
    }
}
