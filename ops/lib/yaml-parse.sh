#!/bin/bash
# yaml-parse.sh — emit a flattened, bash-parseable representation of workshop.yaml.
#
# Uses python3 (macOS ships it; Linux CI has it too). No yq dependency.
#
# Output format — tab-separated records:
#   session\t<session_name>                                (always, first)
#   runtime_default\t<name>                                (always, default=cc)
#   pane\t<name>\t<cwd>\t<main:0|1>\t<arg1|arg2|...>      (per pane)
#   pane_runtime\t<name>\t<runtime>                        (only when overridden)
#   mate\t<name>\t<cwd>\t<desc>\t<default:0|1>             (per mate)
#   mate_runtime\t<name>\t<runtime>                        (only when overridden)
#
# `telegram: true` in the yaml implies main=1 — the pane bound to the daemon's
# `main` channel via KA_CHANNEL (set by start-pane.sh), NOT a CC plugin.
# `main: true` is still accepted for explicit overrides.
# `~` at the start of a cwd is expanded via $HOME.
#
# `runtime: <name>` at top level sets the default agent runtime (cc / codex /
# gemini — only `cc` is implemented today, see docs/KA_CLI_RUNTIME_DESIGN.md).
# Same key on a pane or mate entry overrides the default for that entity.
# Consumers that don't care about runtime can safely ignore pane_runtime /
# mate_runtime / runtime_default records — unknown `kind` values are dropped
# by all current `case $kind in … esac` sites.

set -euo pipefail

CONFIG="${1:?config yaml path required}"

python3 - "$CONFIG" <<'PY'
import sys, re, os

path = sys.argv[1]
with open(path) as f:
    lines = f.read().splitlines()

def strip_comment(s):
    if '#' in s:
        i = s.find('#')
        q = s.count('"', 0, i) + s.count("'", 0, i)
        if q % 2 == 0:
            s = s[:i]
    return s.rstrip()

def unquote(v):
    v = v.strip()
    if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
        return v[1:-1]
    return v

def expand(p):
    return os.path.expanduser(p)

def truthy(v):
    return unquote(v).lower() in ('true', 'yes', '1')

session = None
runtime_default = 'cc'
panes = []
mates = []
section = None      # 'panes' | 'mates' | None
cur = None
in_args = False

def flush():
    global cur
    if cur is None: return
    if section == 'panes':
        panes.append(cur)
    elif section == 'mates':
        mates.append(cur)
    cur = None

for raw in lines:
    line = strip_comment(raw)
    if not line.strip():
        continue
    m = re.match(r'^session:\s*(.+)$', line)
    if m:
        session = unquote(m.group(1)); continue
    # Top-level runtime (only valid outside a section)
    if section is None:
        m = re.match(r'^runtime:\s*(.+)$', line)
        if m:
            runtime_default = unquote(m.group(1)); continue
    if re.match(r'^panes:\s*$', line):
        flush(); section = 'panes'; in_args = False; continue
    if re.match(r'^mates:\s*$', line):
        flush(); section = 'mates'; in_args = False; continue
    m = re.match(r'^\s{2}-\s+name:\s*(.+)$', line)
    if m:
        flush()
        if section == 'panes':
            cur = {'name': unquote(m.group(1)), 'cwd': '', 'main': False,
                   'telegram': False, 'args': [], 'runtime': ''}
        elif section == 'mates':
            cur = {'name': unquote(m.group(1)), 'cwd': '',
                   'description': '', 'default': True, 'runtime': ''}
        in_args = False; continue
    if cur is None:
        continue
    m = re.match(r'^\s{4}cwd:\s*(.+)$', line)
    if m:
        cur['cwd'] = expand(unquote(m.group(1))); in_args = False; continue
    m = re.match(r'^\s{4}runtime:\s*(.+)$', line)
    if m:
        cur['runtime'] = unquote(m.group(1)); in_args = False; continue
    if section == 'panes':
        m = re.match(r'^\s{4}main:\s*(.+)$', line)
        if m:
            cur['main'] = truthy(m.group(1)); in_args = False; continue
        m = re.match(r'^\s{4}telegram:\s*(.+)$', line)
        if m:
            cur['telegram'] = truthy(m.group(1)); in_args = False; continue
        if re.match(r'^\s{4}args:\s*$', line):
            in_args = True; continue
        if in_args:
            m = re.match(r'^\s{6}-\s*(.+)$', line)
            if m:
                cur['args'].append(unquote(m.group(1))); continue
    elif section == 'mates':
        m = re.match(r'^\s{4}description:\s*(.+)$', line)
        if m:
            cur['description'] = unquote(m.group(1)); continue
        m = re.match(r'^\s{4}default:\s*(.+)$', line)
        if m:
            cur['default'] = truthy(m.group(1)); continue

flush()

if not session:
    print("ERROR: session: missing in config", file=sys.stderr); sys.exit(2)

print(f"session\t{session}")
print(f"runtime_default\t{runtime_default}")
for p in panes:
    if not p['cwd']:
        print(f"ERROR: pane {p['name']} missing cwd", file=sys.stderr); sys.exit(2)
    if p['telegram']:
        # `telegram: true` marks the main pane. P2 startup convergence:
        # the Telegram channel now goes through the DAEMON (KA_CHANNEL env set by
        # start-pane.sh), NOT the CC plugin — so we no longer prepend
        # `--channels plugin:telegram@…`. And the CC team mechanism is retired —
        # no `--teammate-mode tmux` prepend either. Mates are independent CC
        # processes in their own tmux panes (ka workshop), not Agent-spawned
        # team subagents.
        p['main'] = True
    args = '|'.join(p['args'])
    main = '1' if p['main'] else '0'
    print(f"pane\t{p['name']}\t{p['cwd']}\t{main}\t{args}")
    if p['runtime']:
        print(f"pane_runtime\t{p['name']}\t{p['runtime']}")
for m in mates:
    if not m['cwd']:
        print(f"ERROR: mate {m['name']} missing cwd", file=sys.stderr); sys.exit(2)
    d = '1' if m['default'] else '0'
    print(f"mate\t{m['name']}\t{m['cwd']}\t{m['description']}\t{d}")
    if m['runtime']:
        print(f"mate_runtime\t{m['name']}\t{m['runtime']}")
PY
