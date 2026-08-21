#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v powershell.exe >/dev/null 2>&1; then
    echo 'ERROR: powershell.exe is unavailable; this skill requires WSL on Windows.' >&2
    exit 2
fi
if ! command -v wslpath >/dev/null 2>&1; then
    echo 'ERROR: wslpath is unavailable; this skill must run inside WSL.' >&2
    exit 2
fi

to_windows_path() {
    wslpath -w "$1"
}

run_ps1() {
    local ps1="$1"
    shift
    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass \
        -File "$(to_windows_path "$script_dir/$ps1")" "$@"
}

usage() {
    cat >&2 <<'USAGE'
Usage:
  securelink.sh status
  securelink.sh capture WINDOW_HANDLE
  securelink.sh cleanup CAPTURE.png
  securelink.sh click-renew WINDOW_HANDLE X Y WIDTH HEIGHT [--dry-run]
  securelink.sh click-connect WINDOW_HANDLE X Y WIDTH HEIGHT disconnect|connect [--dry-run]
  securelink.sh arm-submit WINDOW_HANDLE VERIFIED_CAPTURE.png INPUT_LEFT INPUT_TOP INPUT_WIDTH INPUT_HEIGHT INPUT_X INPUT_Y SUBMIT_X SUBMIT_Y WIDTH HEIGHT [WAIT_SECONDS] [--dry-run]

Never pass a TOTP as an argument. A real arm-submit requires a TTY, disables
terminal echo before printing SECURELINK_SUBMITTER_ARMED, reads one six-digit
code from standard input, and restores the terminal settings on exit.
USAGE
    exit 2
}

validate_private_capture() {
    local capture_path="$1" capture_dir
    capture_dir="${capture_path%/*}"
    [[ "$capture_path" =~ ^/tmp/securelink-renewal\.[A-Za-z0-9]+/window-[0-9]+\.png$ ]] || return 1
    [[ -d "$capture_dir" && ! -L "$capture_dir" && -f "$capture_path" && ! -L "$capture_path" ]] || return 1
    [[ "$(stat -c '%u' "$capture_dir")" == "$(id -u)" && "$(stat -c '%u' "$capture_path")" == "$(id -u)" ]] || return 1
    [[ "$(stat -c '%a' "$capture_dir")" == '700' && "$(stat -c '%a' "$capture_path")" == '600' ]] || return 1
}

command_name="${1:-}"
case "$command_name" in
    status)
        [[ "$#" -eq 1 ]] || usage
        run_ps1 status.ps1
        ;;
    capture)
        [[ "$#" -eq 2 && "$2" =~ ^[0-9]+$ ]] || usage
        old_umask="$(umask)"
        umask 077
        capture_dir="$(mktemp -d /tmp/securelink-renewal.XXXXXX)"
        output_path="$capture_dir/window-$2.png"
        capture_in_progress=1
        cleanup_incomplete_capture() {
            if (( capture_in_progress == 1 )); then
                rm -f -- "$output_path"
                rmdir -- "$capture_dir" 2>/dev/null || true
            fi
        }
        trap cleanup_incomplete_capture EXIT
        trap 'cleanup_incomplete_capture; exit 130' HUP INT TERM
        : > "$output_path"
        chmod 700 "$capture_dir"
        chmod 600 "$output_path"
        umask "$old_umask"
        if ! capture_result="$(run_ps1 capture.ps1 -WindowHandle "$2" -OutputPath "$(to_windows_path "$output_path")")"; then
            rm -f -- "$output_path"
            rmdir -- "$capture_dir" 2>/dev/null || true
            exit 1
        fi
        validate_private_capture "$output_path" || {
            rm -f -- "$output_path"
            rmdir -- "$capture_dir" 2>/dev/null || true
            echo 'ERROR: capture privacy checks failed; the screenshot was removed.' >&2
            exit 1
        }
        unset capture_result
        capture_in_progress=0
        trap - EXIT HUP INT TERM
        printf 'SECURELINK_PRIVATE_CAPTURE=%s\n' "$output_path"
        ;;
    cleanup)
        [[ "$#" -eq 2 ]] || usage
        validate_private_capture "$2" || {
            echo 'ERROR: refusing to remove a path not owned by the managed private capture lifecycle.' >&2
            exit 2
        }
        capture_dir="${2%/*}"
        rm -f -- "$2"
        rmdir -- "$capture_dir" || {
            echo 'ERROR: private capture directory was not empty; only the verified screenshot was removed.' >&2
            exit 1
        }
        printf 'SECURELINK_PRIVATE_CAPTURE_REMOVED\n'
        ;;
    click-renew)
        [[ "$#" -eq 6 || ( "$#" -eq 7 && "${7:-}" == '--dry-run' ) ]] || usage
        args=(-WindowHandle "$2" -X "$3" -Y "$4" -ExpectedWidth "$5" -ExpectedHeight "$6")
        [[ "$#" -eq 6 ]] || args+=(-DryRun)
        run_ps1 click-renew.ps1 "${args[@]}"
        ;;
    click-connect)
        [[ "$#" -eq 7 || ( "$#" -eq 8 && "${8:-}" == '--dry-run' ) ]] || usage
        [[ "$7" == 'disconnect' || "$7" == 'connect' ]] || usage
        args=(-WindowHandle "$2" -X "$3" -Y "$4" -ExpectedWidth "$5" -ExpectedHeight "$6" -ExpectedAction "$7")
        [[ "$#" -eq 7 ]] || args+=(-DryRun)
        run_ps1 click-connect.ps1 "${args[@]}"
        ;;
    arm-submit)
        [[ "$#" -ge 13 && "$#" -le 15 && "$2" =~ ^[0-9]+$ ]] || usage
        validate_private_capture "$3" || {
            echo 'ERROR: arm-submit requires a managed 0700/0600 private capture created by this wrapper.' >&2
            exit 2
        }
        [[ "${3##*/}" == "window-$2.png" ]] || {
            echo 'ERROR: verified capture handle does not match the target window.' >&2
            exit 2
        }
        wait_seconds=45
        dry_run=0
        for arg in "${@:14}"; do
            if [[ "$arg" == '--dry-run' ]]; then
                dry_run=1
            elif [[ "$arg" =~ ^[0-9]+$ ]]; then
                wait_seconds="$arg"
            else
                usage
            fi
        done
        args=(-WindowHandle "$2" -VerifiedCapturePath "$(to_windows_path "$3")" \
              -InputLeft "$4" -InputTop "$5" -InputWidth "$6" -InputHeight "$7" \
              -InputX "$8" -InputY "$9" -SubmitX "${10}" -SubmitY "${11}" \
              -ExpectedWidth "${12}" -ExpectedHeight "${13}" -MaxWaitSeconds "$wait_seconds")
        if (( dry_run == 1 )); then
            run_ps1 arm-submit.ps1 "${args[@]}" -DryRun
            exit 0
        fi

        [[ -t 0 ]] || {
            echo 'ERROR: real arm-submit requires a TTY so terminal echo can be disabled safely.' >&2
            exit 2
        }

        # Validate the window and coordinates before opening the short-lived,
        # no-echo input window. Captured stdout keeps PowerShell from changing
        # the interactive TTY mode during this preflight.
        preflight_output="$(run_ps1 arm-submit.ps1 "${args[@]}" -DryRun </dev/null)"
        printf '%s\n' "$preflight_output"
        challenge_fingerprint="$(printf '%s\n' "$preflight_output" | sed -n 's/\r$//; s/^SECURELINK_CHALLENGE_FINGERPRINT=//p' | tail -n 1)"
        masked_fingerprint="$(printf '%s\n' "$preflight_output" | sed -n 's/\r$//; s/^SECURELINK_MASKED_CHALLENGE_FINGERPRINT=//p' | tail -n 1)"
        if [[ ! "$challenge_fingerprint" =~ ^[A-Fa-f0-9]{64}$ || ! "$masked_fingerprint" =~ ^[A-Fa-f0-9]{64}$ ]]; then
            unset challenge_fingerprint
            unset masked_fingerprint
            echo 'ERROR: preflight did not return a valid challenge fingerprint; no input or click was sent.' >&2
            exit 1
        fi

        saved_terminal_settings="$(stty -g)"
        restore_terminal() {
            stty "$saved_terminal_settings" 2>/dev/null || true
        }
        abort_terminal() {
            restore_terminal
            securelink_one_time_code=''
            unset securelink_one_time_code
            exit 130
        }
        trap restore_terminal EXIT
        trap abort_terminal HUP INT TERM
        stty -echo
        printf 'SECURELINK_SUBMITTER_ARMED\n'

        securelink_one_time_code=''
        if ! IFS= read -r -t "$wait_seconds" securelink_one_time_code; then
            restore_terminal
            trap - EXIT HUP INT TERM
            unset securelink_one_time_code
            echo 'ERROR: timed out without a code; no input or click was sent.' >&2
            exit 1
        fi

        restore_terminal
        trap - EXIT HUP INT TERM
        if [[ ! "$securelink_one_time_code" =~ ^[0-9]{6}$ ]]; then
            securelink_one_time_code=''
            unset securelink_one_time_code
            echo 'ERROR: input was not exactly six ASCII digits; no input or click was sent.' >&2
            exit 1
        fi

        # Feed the already-validated code through anonymous stdin only. The
        # command and its captured output never contain the code.
        submit_output="$(run_ps1 arm-submit.ps1 "${args[@]}" -InputReady \
            -ExpectedFingerprint "$challenge_fingerprint" \
            -ExpectedMaskedFingerprint "$masked_fingerprint" <<<"$securelink_one_time_code")"
        securelink_one_time_code=''
        unset securelink_one_time_code
        unset challenge_fingerprint
        unset masked_fingerprint
        printf '%s\n' "$submit_output"
        ;;
    *)
        usage
        ;;
esac
