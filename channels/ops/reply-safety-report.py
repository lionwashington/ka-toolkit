#!/usr/bin/env python3
# reply-safety-hook monitor — summarize what the Stop hook did over a time window, per pane.
# Reads $KA_HOME/reply-safety-hook.log (the hook's own action log) and reports, for the
# window: Layer-1 re-sends, nudges (by type + whether they recovered), notices (the floor),
# and hook errors — so you can see how often the safety net fired and whether anything fell
# through. Pure read-only; no LLM.
#
#   python3 reply-safety-report.py --hours 18
#   python3 reply-safety-report.py --since "2026-06-09 15:00"
#
# Log timestamps are LOCAL time (the hook logs with strftime); --since/--hours use local too.
import os, re, sys, argparse
from datetime import datetime, timedelta

KA_HOME = os.environ.get("KA_HOME", os.path.expanduser("~/.knowledge-assistant"))
LOG = os.path.join(KA_HOME, "reply-safety-hook.log")

TS = re.compile(r'^\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})\]\s+(.*)')
RESENT = re.compile(r're-sent leaked reply ch=([a-z0-9-]+)')
NUDGE = re.compile(r'nudge #(\d+)/(\d+) \((\w+)\) owner msg (\S+)')
NUDGE_OLD = re.compile(r'nudge: owner msg (\S+)')
NOTICE = re.compile(r'notice \((\w+)\) sent for owner msg (\S+)')
ENTRY = re.compile(r'ENTRY ch=([a-z0-9-]+) .*last_invoke_text=(True|False)')
ERR = re.compile(r'(re-send failed|send_via_daemon failed|optimize failed)')


def parse_dt(s):
    try:
        return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="Summarize reply-safety hook activity per pane.")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--hours", type=float, help="window = last N hours (default 24)")
    g.add_argument("--since", type=str, help='window start, "YYYY-MM-DD HH:MM" (local)')
    ap.add_argument("--log", default=LOG, help="hook log path (default $KA_HOME/reply-safety-hook.log)")
    args = ap.parse_args()

    if args.since:
        try:
            start = datetime.strptime(args.since.strip(), "%Y-%m-%d %H:%M")
        except ValueError:
            print(f"bad --since (want 'YYYY-MM-DD HH:MM'): {args.since}", file=sys.stderr); return 2
    else:
        start = datetime.now() - timedelta(hours=args.hours if args.hours else 24)

    if not os.path.exists(args.log):
        print(f"no hook log at {args.log}", file=sys.stderr); return 1

    panes = {}  # pane -> counters

    def P(name):
        return panes.setdefault(name, {"entry": 0, "leak_entry": 0, "resent": 0, "nudges": 0, "errors": 0})

    last_pane = None        # nudge/notice lines carry no ch= → attribute to the preceding ENTRY
    nudged = {}             # owner msg -> {pane, maxk, type}
    noticed = {}            # owner msg -> {pane, type}
    first_ts = last_ts = None

    for line in open(args.log):
        m = TS.match(line.strip())
        if not m:
            continue
        dt = parse_dt(m.group(1))
        if not dt or dt < start:
            continue
        body = m.group(2)
        first_ts = first_ts or m.group(1)
        last_ts = m.group(1)

        em = ENTRY.search(body)
        if em:
            last_pane = em.group(1)
            p = P(last_pane); p["entry"] += 1
            if em.group(2) == "True":
                p["leak_entry"] += 1
            continue
        rm = RESENT.search(body)
        if rm:
            P(rm.group(1))["resent"] += 1
            continue
        nm = NUDGE.search(body)
        if nm:
            k, _bud, typ, mid = int(nm.group(1)), nm.group(2), nm.group(3), nm.group(4)
            pane = last_pane or "?"
            P(pane)["nudges"] += 1
            e = nudged.setdefault(mid, {"pane": pane, "maxk": 0, "type": typ})
            e["maxk"] = max(e["maxk"], k)
            continue
        if NUDGE_OLD.search(body) and "already" not in body:
            mid = NUDGE_OLD.search(body).group(1)
            pane = last_pane or "?"
            P(pane)["nudges"] += 1
            nudged.setdefault(mid, {"pane": pane, "maxk": 1, "type": "forgot"})
            continue
        no = NOTICE.search(body)
        if no:
            noticed[no.group(2)] = {"pane": last_pane or "?", "type": no.group(1)}
            continue
        if ERR.search(body):
            P(last_pane or "?")["errors"] += 1

    # Derived: nudges that recovered (nudged, never noticed) vs floored (noticed).
    recovered = [mid for mid in nudged if mid not in noticed]
    floored = list(noticed)

    print(f"── reply-safety hook report ──")
    print(f"window: {first_ts or '(none)'} → {last_ts or '(none)'}   (since {start.strftime('%Y-%m-%dT%H:%M')})")
    print()
    if not panes:
        print("  (no hook activity in this window)")
        return 0
    print(f"  {'pane':<14} {'re-sends':>8} {'nudges':>7} {'notices':>8} {'errors':>7}   leak-entries")
    notice_by_pane = {}
    for mid, info in noticed.items():
        notice_by_pane[info["pane"]] = notice_by_pane.get(info["pane"], 0) + 1
    for name in sorted(panes):
        c = panes[name]
        print(f"  {name:<14} {c['resent']:>8} {c['nudges']:>7} {notice_by_pane.get(name,0):>8} {c['errors']:>7}   {c['leak_entry']}")

    tot_resent = sum(c["resent"] for c in panes.values())
    tot_nudges = sum(c["nudges"] for c in panes.values())
    tot_err = sum(c["errors"] for c in panes.values())

    print()
    print("── summary ──")
    print(f"  Layer-1 re-sends (leaked reply → re-sent, delivered):  {tot_resent}")
    print(f"  nudges fired:                                          {tot_nudges}  "
          f"(recovered: {len(recovered)}, escalated-to-notice: {len(floored)})")
    print(f"  notices (the floor — owner told a reply was lost):     {len(floored)}", end="")
    print("   ✅ none" if not floored else "   ⚠️")
    print(f"  hook errors (send/optimize failures):                  {tot_err}", end="")
    print("   ✅ none" if not tot_err else "   ⚠️")
    print()
    # Honest verdict
    saves = tot_resent + len(recovered)
    if floored or tot_err:
        print(f"  → {saves} successful saves; {len(floored)} message(s) hit the floor (owner alerted), {tot_err} error(s).")
        for mid in floored:
            print(f"     notice: msg {mid} ({noticed[mid]['type']}, pane {noticed[mid]['pane']})")
    else:
        print(f"  → {saves} successful saves; 0 floor notices, 0 errors — nothing fell through.")
    print()
    print("  note: 'leak-entries' counts turns where an <invoke> tag was emitted as TEXT. Reply-leaks")
    print("        are re-sent (Layer-1); a leak-entry WITHOUT a re-send is usually a NON-reply tool")
    print("        leak (Bash/etc.) or a reply the pane re-sent itself — not a delivery failure. Only")
    print("        notices/errors are confirmed failures from the log alone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
