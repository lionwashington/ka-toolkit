#!/bin/bash
# schedule-parser.sh — convert a schedule string into launchd-compatible
# StartCalendarInterval dicts.
#
# Usage: schedule-parser.sh "<schedule string>"
# Output (stdout, newline-separated canonical form):
#   Each line is one dict: "Hour=<n>;Minute=<m>[;Weekday=<w>][;Day=<d>][;Month=<M>]"
#   Missing keys mean wildcard.
# Exit 0 on success; 2 on parse error; 3 on unsupported exotic cron.
#
# Supported syntaxes:
#   Natural:
#     "every Nm"          — N in {1,5,10,15,20,30}
#     "every Nh"          — N in {1,2,3,4,6,8,12,24}
#     "daily HH:MM"       — once a day
#     "hourly :MM"        — every hour at minute MM
#   Standard 5-field cron: "M H D Mon W"
#     M ∈ {*, */N, n, n-m, n-m/N}
#     H ∈ {*, */N, n, n-m, n-m/N}
#     D ∈ {*, n}
#     Mon ∈ {*, n}
#     W ∈ {*, n}           (0=Sun, 1=Mon ... 7=Sun)
#   on-event:*             — emits stderr warning, exits 3 (caller disables job)

set -euo pipefail

SCHED="${1:?schedule string required}"

# Use python for CLI simplicity + predictable arithmetic.
python3 - "$SCHED" <<'PY'
import sys, re

s = sys.argv[1].strip()
if not s:
    print("ERROR: empty schedule", file=sys.stderr); sys.exit(2)

# on-event:*
if s.startswith("on-event:"):
    print(f"WARN: on-event schedule '{s}' requires event runtime (not implemented in v1); job should be disabled", file=sys.stderr)
    sys.exit(3)

def emit(h=None, mi=None, w=None, d=None, mon=None):
    parts = []
    if h is not None:   parts.append(f"Hour={h}")
    if mi is not None:  parts.append(f"Minute={mi}")
    if w is not None:   parts.append(f"Weekday={w}")
    if d is not None:   parts.append(f"Day={d}")
    if mon is not None: parts.append(f"Month={mon}")
    print(";".join(parts))

# --- Natural language ---
m = re.fullmatch(r'every\s+(\d+)\s*m(?:in)?', s)
if m:
    n = int(m.group(1))
    if 60 % n != 0 or n < 1 or n > 30:
        print(f"ERROR: every Nm requires N dividing 60 (1,5,10,15,20,30), got {n}", file=sys.stderr); sys.exit(2)
    for mi in range(0, 60, n):
        emit(mi=mi)
    sys.exit(0)

m = re.fullmatch(r'every\s+(\d+)\s*h(?:our)?s?', s)
if m:
    n = int(m.group(1))
    if 24 % n != 0 or n < 1 or n > 24:
        print(f"ERROR: every Nh requires N dividing 24, got {n}", file=sys.stderr); sys.exit(2)
    for h in range(0, 24, n):
        emit(h=h, mi=0)
    sys.exit(0)

m = re.fullmatch(r'daily\s+(\d{1,2}):(\d{2})', s)
if m:
    h, mi = int(m.group(1)), int(m.group(2))
    if not (0 <= h <= 23 and 0 <= mi <= 59):
        print(f"ERROR: daily HH:MM out of range: {s}", file=sys.stderr); sys.exit(2)
    emit(h=h, mi=mi); sys.exit(0)

m = re.fullmatch(r'hourly\s+:(\d{1,2})', s)
if m:
    mi = int(m.group(1))
    if not (0 <= mi <= 59):
        print(f"ERROR: hourly :MM out of range: {s}", file=sys.stderr); sys.exit(2)
    emit(mi=mi); sys.exit(0)

# --- 5-field cron ---
parts = s.split()
if len(parts) == 5:
    m_f, h_f, d_f, mon_f, w_f = parts

    def expand(field, lo, hi):
        # Returns list of int values or None (meaning wildcard)
        if field == '*':
            return None
        results = set()
        for seg in field.split(','):
            step = 1
            if '/' in seg:
                base, stepS = seg.split('/', 1)
                step = int(stepS)
            else:
                base = seg
            if base == '*':
                start, end = lo, hi
            elif '-' in base:
                a, b = base.split('-', 1)
                start, end = int(a), int(b)
            else:
                start = end = int(base)
            v = start
            while v <= end:
                if lo <= v <= hi:
                    results.add(v)
                v += step
        return sorted(results)

    try:
        mins  = expand(m_f,  0, 59)
        hours = expand(h_f,  0, 23)
        days  = expand(d_f,  1, 31)
        mons  = expand(mon_f,1, 12)
        wks_raw = expand(w_f,0, 7)
    except ValueError as e:
        print(f"ERROR: cron parse failed: {e}", file=sys.stderr); sys.exit(2)

    # Normalize weekday 7 → 0 (Sunday)
    wks = None
    if wks_raw is not None:
        wks = sorted({0 if x == 7 else x for x in wks_raw})

    # Cartesian explosion — cap at 500 dicts to avoid insane expansion
    if mins is None:
        # minute wildcard rarely sensible; only allow with explicit hour wildcard → means every minute
        if hours is None and days is None and mons is None and wks is None:
            print("ERROR: '* * * * *' (every minute) not supported; use 'every 1m'", file=sys.stderr); sys.exit(2)
        mins_i = list(range(0, 60))
    else:
        mins_i = mins
    hours_i = hours if hours is not None else [None]
    days_i  = days  if days  is not None else [None]
    mons_i  = mons  if mons  is not None else [None]
    wks_i   = wks   if wks   is not None else [None]

    total = 0
    for mo in mons_i:
        for d in days_i:
            for w in wks_i:
                for h in hours_i:
                    for mi in mins_i:
                        total += 1
                        if total > 500:
                            print("ERROR: cron expansion exceeds 500 entries; schedule too dense", file=sys.stderr); sys.exit(2)
                        emit(h=h, mi=mi, w=w, d=d, mon=mo)
    sys.exit(0)

print(f"ERROR: unrecognized schedule syntax: {s}", file=sys.stderr)
sys.exit(2)
PY
