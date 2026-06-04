#!/bin/bash
# parse-yaml.sh — emit a flattened, bash-parseable representation of cron.yaml.
#
# Output format — tab-separated records, one per record:
#   version\t<n>
#   default\t<key>\t<value>         (one per defaults.* key)
#   job\t<name>\t<field>\t<value>   (per-field emission)
#       fields: schedule, kind, command, description, target_pane,
#               enabled, flock, log_keep_mb, env_<KEY>
#
# Absent optional fields are not emitted. Caller applies defaults.

set -euo pipefail

CONFIG="${1:?cron.yaml path required}"

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

def truthy(v):
    return unquote(v).lower() in ('true', 'yes', '1')

version = 1
defaults = {}
jobs = []
section = None   # 'defaults' | 'jobs' | None
cur = None
in_env = False

def flush():
    global cur, in_env
    if cur is not None:
        jobs.append(cur)
    cur = None
    in_env = False

for raw in lines:
    line = strip_comment(raw)
    if not line.strip():
        continue
    m = re.match(r'^version:\s*(.+)$', line)
    if m:
        version = int(unquote(m.group(1))); continue
    if re.match(r'^defaults:\s*$', line):
        flush(); section = 'defaults'; continue
    if re.match(r'^jobs:\s*$', line):
        flush(); section = 'jobs'; continue

    if section == 'defaults':
        m = re.match(r'^\s{2}([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$', line)
        if m:
            defaults[m.group(1)] = unquote(m.group(2)); continue

    if section == 'jobs':
        m = re.match(r'^\s{2}-\s+name:\s*(.+)$', line)
        if m:
            flush()
            cur = {'name': unquote(m.group(1))}
            continue
        if cur is None:
            continue
        # env: sub-map
        if re.match(r'^\s{4}env:\s*$', line):
            in_env = True; continue
        if in_env:
            m = re.match(r'^\s{6}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$', line)
            if m:
                cur.setdefault('env', {})[m.group(1)] = unquote(m.group(2)); continue
            # any non-env-indented line ends the env block
            if not re.match(r'^\s{6}', line):
                in_env = False
        m = re.match(r'^\s{4}([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$', line)
        if m:
            cur[m.group(1)] = unquote(m.group(2)); continue

flush()

print(f"version\t{version}")
for k, v in defaults.items():
    print(f"default\t{k}\t{v}")

for j in jobs:
    name = j.get('name', '')
    if not name:
        print("ERROR: job missing name", file=sys.stderr); sys.exit(2)
    for field in ('schedule', 'kind', 'command', 'description',
                  'target_pane', 'enabled', 'flock', 'log_keep_mb'):
        if field in j:
            print(f"job\t{name}\t{field}\t{j[field]}")
    for k, v in (j.get('env') or {}).items():
        print(f"job\t{name}\tenv_{k}\t{v}")
PY
