#!/usr/bin/env python3
# Stop hook — deterministic reply-repair for the Opus "tool-call-as-text" bug.
#
# When the model leaks a `reply` tool call as literal TEXT (a bare `<invoke
# name="...reply">…</invoke>` instead of a structured tool_use, sometimes with a stray
# "card" prefix / dropped antml: namespace — a known Opus 4.8 few-shot-poisoning bug),
# the reply never executes and the owner sees silence ("又不回我"). This hook detects
# that leak in the just-finished turn and RE-SENDS it via the daemon's /api/send, so the
# message still lands — on whatever platform is active (telegram/lark; the daemon picks).
#
# 🔴 NO LLM is involved — pure regex + one HTTP POST. It cannot loop: it emits no model
# output and never continues the turn (exits 0). Only the `reply` tool is auto-repaired;
# other leaked tools (Bash/Read/…) are NEVER auto-executed (logged for visibility only).
#
# Registered as a GLOBAL Stop hook (~/.claude/settings.json) → runs for every pane. It
# no-ops unless KA_CHANNEL + KA_CHANNEL_PORT are in env (i.e. only on channel panes).
import sys, os, json, re, hashlib, urllib.request, time

def log(msg):
    try:
        d = os.environ.get("KA_HOME", os.path.expanduser("~/.knowledge-assistant"))
        with open(os.path.join(d, "reply-repair-hook.log"), "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}\n")
    except Exception:
        pass

# Leaked reply written as text. Tolerant of: card/stray prefix, bare <invoke> (no
# <function_calls> wrapper), dropped antml: namespace, any mcp__*__reply tool name.
LEAK_RE = re.compile(
    r'<invoke\s+name="mcp__[a-z0-9_-]+__reply">.*?'
    r'<parameter\s+name="chat_id">(?P<cid>[^<]+)</parameter>.*?'
    r'<parameter\s+name="text">(?P<txt>.*?)</parameter>\s*</invoke>',
    re.S)

def main():
    # 1) hook input on stdin
    try:
        inp = json.load(sys.stdin)
    except Exception:
        return 0
    transcript = inp.get("transcript_path")
    session_id = inp.get("session_id", "")
    if not transcript or not os.path.exists(transcript):
        return 0

    # 2) only act on channel panes (env set by start-pane.sh); else no-op
    channel = os.environ.get("KA_CHANNEL")
    port = os.environ.get("KA_CHANNEL_PORT")
    if not channel or not port:
        return 0

    # 3) parse transcript jsonl → messages in order
    msgs = []
    try:
        with open(transcript) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                m = o.get("message", o)
                if isinstance(m, dict) and m.get("role") in ("user", "assistant"):
                    msgs.append(m)
    except Exception:
        return 0
    if not msgs:
        return 0

    # 4) scope to the CURRENT turn = assistant messages after the last real user message
    last_user = max((i for i, m in enumerate(msgs) if m.get("role") == "user"), default=-1)
    turn = msgs[last_user + 1:]

    # collect, within this turn: (a) leaked replies (text), (b) successfully-sent replies
    # (real tool_use name endswith reply). A leak whose text matches a real tool_use was
    # already sent by a retry → skip it (no double-send).
    def blocks(m):
        c = m.get("content")
        return c if isinstance(c, list) else ([{"type": "text", "text": c}] if isinstance(c, str) else [])

    sent_texts = set()
    leaks = []  # (chat_id, text)
    for m in turn:
        if m.get("role") != "assistant":
            continue
        for b in blocks(m):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and str(b.get("name", "")).endswith("reply"):
                inp2 = b.get("input", {})
                if isinstance(inp2, dict) and inp2.get("text"):
                    sent_texts.add(inp2["text"])
            elif b.get("type") == "text":
                for mo in LEAK_RE.finditer(b.get("text", "")):
                    leaks.append((mo.group("cid").strip(), mo.group("txt")))

    if not leaks:
        return 0

    # 5) de-dup persistence: never re-send the same (session, chat_id, text) twice
    statedir = os.environ.get("KA_HOME", os.path.expanduser("~/.knowledge-assistant"))
    statefile = os.path.join(statedir, "reply-repair-sent.txt")
    seen = set()
    try:
        with open(statefile) as f:
            seen = set(l.strip() for l in f)
    except Exception:
        pass

    for chat_id, text in leaks:
        if text in sent_texts:
            continue  # a real reply with this text already went out (retry succeeded)
        key = hashlib.sha256(f"{session_id}|{chat_id}|{text}".encode()).hexdigest()
        if key in seen:
            continue  # already re-sent by a previous Stop firing
        # 6) re-send via the daemon (kind-aware: daemon uses the active platform)
        try:
            body = json.dumps({"channel": channel, "target": chat_id, "text": text}).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/send", data=body,
                headers={"content-type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=5) as r:
                ok = json.loads(r.read()).get("ok")
            if ok:
                seen.add(key)
                with open(statefile, "a") as f:
                    f.write(key + "\n")
                log(f"re-sent leaked reply ch={channel} chat={chat_id} len={len(text)}")
            else:
                log(f"/api/send not ok ch={channel} chat={chat_id}")
        except Exception as e:
            log(f"re-send failed ch={channel} chat={chat_id}: {e}")

    return 0

if __name__ == "__main__":
    sys.exit(main())
