#!/bin/bash

runtime::launch_pane_script() {
    printf '%s' "${KA_RUNTIMES_DIR}/codex/bin/start-pane.sh"
}

runtime::launch_binary() {
    printf 'codex'
}
