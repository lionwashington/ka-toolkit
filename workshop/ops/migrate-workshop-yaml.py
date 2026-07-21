#!/usr/bin/env python3
# migrate-workshop-yaml.py — migrate a workshop.yaml from the legacy two-section
# schema (`panes:` + `mates:`, with `telegram: true`) to the merged single
# `mates:` schema (every agent under `mates:`, with an optional main alias).
#
#   legacy                              merged
#   ------                              ------
#   panes: - name: main                mates: - name: main
#            cwd: ~/x                            cwd: ~/x
#            telegram: true   (or main:true)     main: true
#   mates: - name: dev ...                     - name: dev ...
#
# Transform rules (data-preserving):
#   - a `panes:` entry with telegram:true OR main:true → a mate with main:true
#   - any other `panes:` entry            → a mate (non-main; it was a non-lead pane)
#   - existing `mates:` entries           → kept verbatim
#   - name / cwd / args / description / default / runtime carried over unchanged
#   - cwd text is preserved as written (NO ~ expansion — the runtime expands it)
#   - order preserved: panes-section entries first, then mates
#
# Usage:
#   migrate-workshop-yaml.py <in.yaml>            # print migrated YAML to stdout
#   migrate-workshop-yaml.py <in.yaml> --check    # self-check: re-read the output
#                                                 # and assert the entry data is
#                                                 # byte-identical (idempotent /
#                                                 # data-preserving). Exit !=0 on drift.
# Idempotent: a file already in the merged schema migrates to itself.
import sys, re

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

def parse(path):
    """Permissive reader: understands BOTH the legacy and merged schemas.
    Returns (session, runtime_default_or_None, [entry dicts]) preserving order."""
    with open(path) as f:
        lines = f.read().splitlines()
    session = None
    runtime_default = None
    entries = []
    section = None      # 'panes' | 'mates' | None
    cur = None
    in_args = False

    def flush():
        nonlocal cur
        if cur is not None:
            entries.append(cur)
            cur = None

    for raw in lines:
        line = strip_comment(raw)
        if not line.strip():
            continue
        m = re.match(r'^session:\s*(.+)$', line)
        if m:
            session = unquote(m.group(1)); continue
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
            cur = {'name': unquote(m.group(1)), 'cwd': '', 'args': [],
                   'description': '', 'main': False, 'default': True,
                   'runtime': '', 'section': section}
            in_args = False; continue
        if cur is None:
            continue
        m = re.match(r'^\s{4}cwd:\s*(.+)$', line)
        if m:
            cur['cwd'] = unquote(m.group(1)); in_args = False; continue   # keep raw (no ~ expand)
        m = re.match(r'^\s{4}runtime:\s*(.+)$', line)
        if m:
            cur['runtime'] = unquote(m.group(1)); in_args = False; continue
        m = re.match(r'^\s{4}(?:main|telegram):\s*(.+)$', line)
        if m:
            if truthy(m.group(1)):
                cur['main'] = True
            in_args = False; continue
        m = re.match(r'^\s{4}description:\s*(.+)$', line)
        if m:
            cur['description'] = unquote(m.group(1)); in_args = False; continue
        m = re.match(r'^\s{4}default:\s*(.+)$', line)
        if m:
            cur['default'] = truthy(m.group(1)); in_args = False; continue
        if re.match(r'^\s{4}args:\s*$', line):
            in_args = True; continue
        if in_args:
            m = re.match(r'^\s{6}-\s*(.+)$', line)
            if m:
                cur['args'].append(unquote(m.group(1))); continue
    flush()
    return session, runtime_default, entries

HEADER = """\
# Workshop agents (merged schema). Every agent is an equivalent entry under
# `mates:`; zero or one may use `main: true` as a Channel alias. Migrated by
# migrate-workshop-yaml.py. Per-entry keys: name / cwd / args / description /
# main (default false) / default (default true).
"""

def emit(session, runtime_default, entries):
    out = [HEADER.rstrip(), ""]
    if session is None:
        sys.stderr.write("ERROR: no `session:` in input\n"); sys.exit(2)
    out.append(f"session: {session}")
    if runtime_default is not None:
        out.append(f"runtime: {runtime_default}")
    out.append("")
    out.append("mates:")
    for e in entries:
        out.append(f"  - name: {e['name']}")
        out.append(f"    cwd: {e['cwd']}")
        if e['main']:
            out.append("    main: true")
        if e['args']:
            out.append("    args:")
            for a in e['args']:
                out.append(f"      - {a}")
        if e['description']:
            out.append(f"    description: {e['description']}")
        if not e['default']:
            out.append("    default: false")
        if e['runtime']:
            out.append(f"    runtime: {e['runtime']}")
    return "\n".join(out) + "\n"

def normalize(entries):
    """Comparable view of the entry data (ignores which section it came from)."""
    return [(e['name'], e['cwd'], tuple(e['args']), e['description'],
             e['main'], e['default'], e['runtime']) for e in entries]

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: migrate-workshop-yaml.py <in.yaml> [--check]\n"); sys.exit(2)
    path = sys.argv[1]
    check = '--check' in sys.argv[2:]
    session, rt, entries = parse(path)
    migrated = emit(session, rt, entries)
    if check:
        # Re-parse the emitted YAML; the entry data must be identical (the
        # migration neither drops nor mangles any field) and idempotent.
        import tempfile, os
        fd, tmp = tempfile.mkstemp(suffix='.yaml'); os.close(fd)
        try:
            with open(tmp, 'w') as f:
                f.write(migrated)
            s2, rt2, e2 = parse(tmp)
            again = emit(s2, rt2, e2)
        finally:
            os.unlink(tmp)
        if normalize(entries) != normalize(e2):
            sys.stderr.write("CHECK FAILED: entry data changed across migration\n")
            sys.exit(3)
        if migrated != again:
            sys.stderr.write("CHECK FAILED: migration is not idempotent\n")
            sys.exit(3)
        sys.stderr.write("CHECK OK: data-preserving + idempotent\n")
    sys.stdout.write(migrated)

if __name__ == '__main__':
    main()
