#!/bin/bash
# yaml-parse.sh — emit a flattened, bash-parseable representation of workshop.yaml.
#
# Uses python3 (macOS ships it; Linux CI has it too). No yq dependency.
#
# SCHEMA (single `mates:` section):
#   Every agent is one equivalent entry under `mates:`. `main: true` is an
#   optional channel alias: at most one entry may use it, and that entry binds
#   to `main`; with no such entry every agent binds under its own name.
#   Per-entry keys: name / cwd / args / description / main / default / runtime.
#     - main    defaults to false
#     - default defaults to true   (false = optional, not spawned unless asked)
#
# Output format — tab-separated records:
#   session\t<session_name>                                (always, first)
#   runtime_default\t<name>                                (always, default=cc)
#   mate\t<name>\t<cwd>\t<desc>\t<default:0|1>             (per entry)
#   mate_main\t<name>\t1                                  (only for main:true)
#   mate_args\t<name>\t<arg1|arg2|...>                     (only when args given)
#   mate_runtime\t<name>\t<runtime>                        (only when overridden)
#
# The `mate` record stays 4 fields wide — mate args ride a separate `mate_args`
# record (like `mate_runtime`) so existing 4-field consumers need no change.
# `~` at the start of a cwd is expanded via $HOME.
#
# `runtime: <name>` at top level sets the default agent runtime. `cc` and
# `codex` are implemented; `gemini` remains reserved and fails closed.
# Same key on an entry overrides the default for that entity.
# Consumers that don't care about runtime / mate_args can safely ignore those
# records — unknown `kind` values are dropped by all current
# `case $kind in … esac` sites.
#
# REMOVED (hard error, points at the new schema): the legacy `panes:` section
# and the `telegram:` key. Put every agent under `mates:` and use optional
# `main: true` only if a `main` channel alias is wanted.

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
entries = []        # single unified list (the `mates:` section)
section = None      # 'mates' | None
cur = None
in_args = False

def flush():
    global cur
    if cur is None: return
    if section == 'mates':
        entries.append(cur)
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
        print("ERROR: `panes:` is removed — put every agent under `mates:`",
              file=sys.stderr); sys.exit(2)
    if re.match(r'^mates:\s*$', line):
        flush(); section = 'mates'; in_args = False; continue
    m = re.match(r'^\s{2}-\s+name:\s*(.+)$', line)
    if m:
        flush()
        if section == 'mates':
            cur = {'name': unquote(m.group(1)), 'cwd': '', 'args': [],
                   'description': '', 'main': False, 'default': True, 'runtime': ''}
        in_args = False; continue
    if cur is None:
        continue
    m = re.match(r'^\s{4}cwd:\s*(.+)$', line)
    if m:
        cur['cwd'] = expand(unquote(m.group(1))); in_args = False; continue
    m = re.match(r'^\s{4}runtime:\s*(.+)$', line)
    if m:
        cur['runtime'] = unquote(m.group(1)); in_args = False; continue
    m = re.match(r'^\s{4}main:\s*(.+)$', line)
    if m:
        cur['main'] = truthy(m.group(1)); in_args = False; continue
    m = re.match(r'^\s{4}description:\s*(.+)$', line)
    if m:
        cur['description'] = unquote(m.group(1)); in_args = False; continue
    m = re.match(r'^\s{4}default:\s*(.+)$', line)
    if m:
        cur['default'] = truthy(m.group(1)); in_args = False; continue
    if re.match(r'^\s{4}telegram:\s*', line):
        print("ERROR: `telegram:` is removed — use optional `main: true` for a "
              "main channel alias (the channel goes through the daemon, not a plugin)",
              file=sys.stderr); sys.exit(2)
    if re.match(r'^\s{4}args:\s*$', line):
        in_args = True; continue
    if in_args:
        m = re.match(r'^\s{6}-\s*(.+)$', line)
        if m:
            cur['args'].append(unquote(m.group(1))); continue

flush()

if not session:
    print("ERROR: session: missing in config", file=sys.stderr); sys.exit(2)

print(f"session\t{session}")
print(f"runtime_default\t{runtime_default}")

main_entries = [e for e in entries if e['main']]
if len(main_entries) > 1:
    names = ', '.join(e['name'] for e in main_entries)
    print(f"ERROR: at most one entry may set main: true (found: {names})", file=sys.stderr)
    sys.exit(2)

for m in entries:
    if not m['cwd']:
        print(f"ERROR: entry {m['name']} missing cwd", file=sys.stderr); sys.exit(2)
    d = '1' if m['default'] else '0'
    print(f"mate\t{m['name']}\t{m['cwd']}\t{m['description']}\t{d}")
    if m['main']:
        print(f"mate_main\t{m['name']}\t1")
    if m['args']:
        print(f"mate_args\t{m['name']}\t{'|'.join(m['args'])}")
    if m['runtime']:
        print(f"mate_runtime\t{m['name']}\t{m['runtime']}")
PY
