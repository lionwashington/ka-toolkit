#!/usr/bin/env python3
# Stop hook — reply-delivery safety net for Opus's two reply-to-owner failure modes.
# The hook itself runs NO LLM (pure regex + one HTTP POST or a decision:block); it cannot
# loop. Registered GLOBALLY (~/.claude/settings.json Stop) so every pane gets it; no-ops
# unless KA_CHANNEL + KA_CHANNEL_PORT are in env (channel panes only).
#
#  BRANCH 1 — LEAK repair: the model emitted the reply tool call as literal <invoke> TEXT
#    instead of a structured tool_use (few-shot-poisoning bug) → the reply never executed.
#    Extract chat_id+text from the leaked text and re-send via the daemon /api/send (which
#    sends through the active platform: telegram bot / lark webhook). Deterministic, dedup'd.
#
#  BRANCH 2 — FORGOT nudge: an owner channel message was answered in plain terminal text
#    but the model never called reply → the owner saw nothing. We can't re-send (no tool
#    call to extract), so we return decision:block telling the model to reply now. That
#    re-engages the model for ONE more turn (bounded: at most one nudge per owner message
#    → no loop). Excludes parse-error / leak turns (those are the parse bug, not a forget).
import sys, os, json, re, hashlib, urllib.request, time

KA_HOME = os.environ.get("KA_HOME", os.path.expanduser("~/.knowledge-assistant"))

def log(msg):
    try:
        with open(os.path.join(KA_HOME, "reply-safety-hook.log"), "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}\n")
    except Exception:
        pass

LEAK_RE = re.compile(
    r'<invoke\s+name="mcp__[a-z0-9_-]+__reply">.*?'
    r'<parameter\s+name="chat_id">(?P<cid>[^<]+)</parameter>.*?'
    r'<parameter\s+name="text">(?P<txt>.*?)</parameter>\s*</invoke>',
    re.S)
OWNER_TAG = '<channel source="telegram-channel"'   # owner channel-message marker
PARSE_ERR = "could not be parsed"
TEXT_MIN = 30

def blocks(m):
    c = m.get("content")
    return c if isinstance(c, list) else ([{"type": "text", "text": c}] if isinstance(c, str) else [])

def is_owner_msg(m):
    if m.get("role") != "user":
        return False
    for b in blocks(m):
        if isinstance(b, dict) and b.get("type") == "text":
            t = b.get("text", "")
            if OWNER_TAG in t and 'source="cc"' not in t and 'from_channel=' not in t:
                return True
    return False

def state_load(path):
    try:
        return set(l.strip() for l in open(path))
    except Exception:
        return set()

def state_add(path, key):
    try:
        with open(path, "a") as f:
            f.write(key + "\n")
    except Exception:
        pass

def main():
    try:
        inp = json.load(sys.stdin)
    except Exception:
        return 0
    transcript = inp.get("transcript_path")
    session_id = inp.get("session_id", "")
    channel = os.environ.get("KA_CHANNEL")
    port = os.environ.get("KA_CHANNEL_PORT")
    if not (transcript and os.path.exists(transcript) and channel and port):
        return 0

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
                    m["_apierr"] = bool(o.get("isApiErrorMessage"))
                    msgs.append(m)
    except Exception:
        return 0
    if not msgs:
        return 0

    # ── BRANCH 1: leak repair — re-send any reply the model leaked as <invoke> text ──
    last_user = max((i for i, m in enumerate(msgs) if m.get("role") == "user"), default=-1)
    sent_texts, leaks = set(), []
    for m in msgs[last_user + 1:]:
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
    if leaks:
        statefile = os.path.join(KA_HOME, "reply-safety-sent.txt")
        seen = state_load(statefile)
        for chat_id, text in leaks:
            if text in sent_texts:
                continue
            key = hashlib.sha256(f"resend|{session_id}|{chat_id}|{text}".encode()).hexdigest()
            if key in seen:
                continue
            try:
                body = json.dumps({"channel": channel, "target": chat_id, "text": text}).encode()
                req = urllib.request.Request(f"http://127.0.0.1:{port}/api/send", data=body,
                    headers={"content-type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=5) as r:
                    if json.loads(r.read()).get("ok"):
                        state_add(statefile, key); seen.add(key)
                        log(f"re-sent leaked reply ch={channel} chat={chat_id} len={len(text)}")
            except Exception as e:
                log(f"re-send failed ch={channel}: {e}")
        return 0  # handled a leak this turn → do not also nudge

    # ── BRANCH 2: forgot-reply nudge ────────────────────────────────────────────
    owner_idx = [i for i, m in enumerate(msgs) if is_owner_msg(m)]
    if not owner_idx:
        return 0
    oi = owner_idx[-1]
    owner_text = ""
    for b in blocks(msgs[oi]):
        if isinstance(b, dict) and b.get("type") == "text":
            owner_text = b.get("text", "")
    has_reply = is_parse_err = False
    best = ""
    for m in msgs[oi + 1:]:
        if m.get("role") != "assistant":
            continue
        if m.get("_apierr"):
            is_parse_err = True
        for b in blocks(m):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and str(b.get("name", "")).endswith("reply"):
                has_reply = True
            elif b.get("type") == "text":
                txt = b.get("text", "")
                if PARSE_ERR in txt or "<invoke" in txt:
                    is_parse_err = True          # parse-error / leak text → not a forget
                elif len(txt) > len(best):
                    best = txt
    # replied / parse-bug / nothing substantive → no nudge
    if has_reply or is_parse_err or len(best) < TEXT_MIN:
        return 0

    # forgot → nudge ONCE per owner message (then give up; no loop)
    mm = re.search(r'message_id="([^"]+)"', owner_text)
    mid = mm.group(1) if mm else hashlib.sha256(owner_text.encode()).hexdigest()[:16]
    nfile = os.path.join(KA_HOME, "reply-safety-nudged.txt")
    nkey = f"{session_id}|{mid}"
    if nkey in state_load(nfile):
        log(f"already nudged for owner msg {mid}; giving up (no loop)")
        return 0
    state_add(nfile, nkey)
    log(f"nudge: owner msg {mid} answered in terminal w/o reply → decision:block")
    print(json.dumps({
        "decision": "block",
        "reason": ("你刚回答了主人,但没用 reply 工具发出去 —— 主人在 Telegram/Lark 收不到终端正文。"
                   "现在立刻用 reply 工具(带 chat_id)把你刚才那条答案发给主人。给主人的回复必须走 reply 工具。"),
    }))
    return 0

if __name__ == "__main__":
    sys.exit(main())
