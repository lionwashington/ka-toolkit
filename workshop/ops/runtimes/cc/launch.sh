#!/bin/bash
# cc/launch.sh — CC adapter: how to spawn `claude` inside a tmux pane.
#
# The actual pane entrypoint is ops/lib/start-pane.sh — it handles the three-
# layer cwd guarantee and waits for `claude` to appear on PATH. We keep that
# script where it is (tmux runs it directly as an executable) and this adapter
# just exposes its path + the CC-specific binary name.
#
# See docs/components/workshop-runtime-interface.md §runtime::launch_pane.

# runtime::launch_pane_script
# Echo the absolute path of the pane entrypoint. start.sh uses this to build
# the tmux `new-session`/`new-window` command line.
runtime::launch_pane_script() {
    printf '%s' "${KA_RUNTIMES_DIR}/../start-pane.sh"
}

# runtime::launch_binary
# Echo the name of the agent binary this runtime drives. Used by the pane
# entrypoint's PATH check.
runtime::launch_binary() {
    printf 'claude'
}
