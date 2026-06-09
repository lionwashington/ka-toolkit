#!/usr/bin/env python3
# Stop hook — reply-delivery safety net for Opus's reply-to-owner failure modes.
# The hook runs NO LLM (pure regex + at most one HTTP POST or a decision:block); it
# cannot loop. Registered GLOBALLY (~/.claude/settings.json Stop) so every pane gets
# it; no-ops unless KA_CHANNEL + KA_CHANNEL_PORT are in env (channel panes only).
#
# NORTH STAR (owner, 2026-06-09): EVERY message the owner sends from Telegram/Lark must
# get a response — either the real answer, or an explicit notice telling them which error
# ate it. NEVER silence. The hook is responsible for each owner message to the end.
#
# Two mechanisms:
#   · nudge  — a decision:block that re-engages the MODEL for one more turn (used when the
#              model can plausibly recover — bounded per message, no loop).
#   · notice — the HOOK itself POSTs a FIXED message to the daemon /api/send (the daemon
#              prefixes [#num-name] + routes to the active platform). Model-independent: when
#              the model's tool-call emission is broken it can't send its own error notice,
#              so the hook must. No text is extracted → a notice can never leak garbage.
#
# LAYER 1 — LEAK re-send: the model emitted a *well-formed* reply tool call as literal
#   <invoke> TEXT (few-shot poisoning) → never executed. Extract chat_id+text and re-send
#   via /api/send. Deterministic, dedup'd. This counts as ANSWERED.
#
# LAYER 2 — ensure-answered escalation: for the last owner message that has no successful
#   reply, classify why and escalate. nudge budget is per failure TYPE (poisoned context
#   doesn't recover from extra nudges — the cure is /compact, so don't spin):
#     FORGOT (clean answer in terminal, just no reply tool) / SILENT (nothing) → nudge x2 → notice
#     MALFORMED reply (a reply tag as text we can't extract) / PARSE-ERROR        → nudge x1 → notice
#   Each owner message: at most 2 decision:blocks + exactly 1 notice → bounded, no loop,
#   and never silent.
import sys, os, json, re, hashlib, urllib.request, time

KA_HOME = os.environ.get("KA_HOME", os.path.expanduser("~/.knowledge-assistant"))

def log(msg):
    try:
        with open(os.path.join(KA_HOME, "reply-safety-hook.log"), "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}\n")
    except Exception:
        pass

# A well-formed leaked reply: full <invoke …reply> with chat_id + text → re-sendable (layer 1).
LEAK_RE = re.compile(
    r'<invoke\s+name="mcp__[a-z0-9_-]+__reply">.*?'
    r'<parameter\s+name="chat_id">(?P<cid>[^<]+)</parameter>.*?'
    r'<parameter\s+name="text">(?P<txt>.*?)</parameter>\s*</invoke>',
    re.S)
# Owner channel-message marker — platform-agnostic: telegram-channel / lark-channel / …
# (the `<channel source="X">` tag's X = the MCP server name = "<platform>-channel"; cc
# messages are source="cc" and excluded below). Hardcoding telegram broke lark's nudge.
OWNER_TAG_RE = re.compile(r'<channel\s+source="[a-z]+-channel"')
# Just the OPENING of a reply tool call leaked as text. A match that LEAK_RE can NOT fully
# extract = a MALFORMED reply (truncated/corrupted tag) → can't re-send, so → notice.
REPLY_LEAK_TAG = re.compile(r'<invoke\s+name="mcp__[a-z0-9_-]+__reply"')
# The owner's chat_id rides in the channel meta tag — the address a notice is sent to.
CHAT_ID_RE = re.compile(r'chat_id="([^"]+)"')
PARSE_ERR = "could not be parsed"
TEXT_MIN = 30

# Per-type nudge reasons (decision:block) and owner-facing notices (hook → /api/send;
# the daemon adds the [#num-name] prefix, so these don't name the pane themselves).
NUDGE_REASON = {
    "forgot": ("你刚回答了主人,但没用 reply 工具发出去 —— 主人在 Telegram/Lark 收不到终端正文。"
               "现在立刻用 reply 工具(带 chat_id)把你刚才那条答案发给主人。给主人的回复必须走 reply 工具。"),
    "silent": ("主人发来了消息,但你这一轮结束时没有回复主人。现在用 reply 工具(带 chat_id)回复主人;"
               "若你还在处理,也先发一句简短状态,别让主人空等。"),
    "malformed": ("你上一轮回复主人时 reply 工具调用没能成功发出(畸形/解析失败)。现在重新用 reply 工具"
                  "(带 chat_id)回复主人,内容尽量简短,以降低再次畸形的概率。"),
    "parse_error": ("你上一轮的工具调用 parse error、没能发出。现在重新用 reply 工具(带 chat_id)回复主人,"
                    "内容尽量简短,以降低再次畸形的概率。"),
}
NOTICE = {
    "malformed": "⚠️ 我回复你时 reply 工具调用畸形了,消息没能发出。先告诉你别漏掉 —— 建议 /compact 让我恢复。",
    "parse_error": "⚠️ 我回复你时工具调用 parse error 了,消息没能发出。先告诉你别漏掉 —— 建议 /compact 让我恢复。",
    "forgot": "⚠️ 你刚发的消息我回答了,但连续没能用 reply 工具发出。先告诉你别漏掉 —— 建议 /compact。",
    "silent": "⚠️ 你刚发的消息我一直没能回复(工具调用故障)。先告诉你别漏掉 —— 建议 /compact。",
}
NUDGE_BUDGET = {"forgot": 2, "silent": 2, "malformed": 1, "parse_error": 1}

def blocks(m):
    c = m.get("content")
    return c if isinstance(c, list) else ([{"type": "text", "text": c}] if isinstance(c, str) else [])

def is_owner_msg(m):
    if m.get("role") != "user":
        return False
    for b in blocks(m):
        if isinstance(b, dict) and b.get("type") == "text":
            t = b.get("text", "")
            if OWNER_TAG_RE.search(t) and 'source="cc"' not in t and 'from_channel=' not in t:
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

def nudges_done(path, prefix):
    """How many nudges already issued for this owner message (lines `prefix|N`)."""
    n = 0
    try:
        for l in open(path):
            l = l.strip()
            if l.startswith(prefix + "|"):
                try:
                    n = max(n, int(l.rsplit("|", 1)[1]))
                except Exception:
                    pass
    except Exception:
        pass
    return n

def send_via_daemon(port, channel, target, text):
    """POST to the daemon /api/send (it adds [#num-name] + routes to the active platform).
    Used by layer-1 re-send AND layer-2 notices. Returns True on ok."""
    try:
        body = json.dumps({"channel": channel, "target": target, "text": text}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/send", data=body,
            headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=5) as r:
            return bool(json.loads(r.read()).get("ok"))
    except Exception as e:
        log(f"send_via_daemon failed ch={channel}: {e}")
        return False

def load_messages(transcript):
    """Parse the transcript JSONL into user/assistant messages (with _apierr flag).
    Returns None on read error, [] when the file holds no qualifying messages yet."""
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
        return None
    return msgs

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

    # Stop hook can fire BEFORE Claude Code flushes the turn's final assistant block to the
    # transcript. If the tail is still a USER message (no assistant after it), the turn we're
    # meant to police hasn't landed yet — short-poll re-read until an assistant turn appears
    # or we time out (~1.5s). Fixes the race that silently dropped BOTH the leak re-send
    # (msg 2920) and the forgot nudge (msg 3118). Cheap: only waits in that suspicious
    # "tail is a user message" state; a normally-completed turn already has its assistant
    # block on disk, so this loop doesn't run at all.
    msgs = load_messages(transcript)
    if msgs is None:
        return 0
    SETTLE_MS, POLL_MS = 1500, 400
    waited = 0
    while waited < SETTLE_MS and msgs and msgs[-1].get("role") == "user":
        time.sleep(POLL_MS / 1000.0)
        waited += POLL_MS
        m2 = load_messages(transcript)
        if m2:
            msgs = m2
    if not msgs:
        return 0

    # ── DIAGNOSTIC entry log — one line per invocation on a channel pane. Splits "Stop hook
    # never fired" (NO line) from "fired but the leaked reply wasn't on disk yet" (line with
    # last_invoke_text=False).
    _last_asst = next((m for m in reversed(msgs) if m.get("role") == "assistant"), None)
    _last_sr = _last_asst.get("stop_reason") if _last_asst else None
    _last_leak = any(isinstance(b, dict) and b.get("type") == "text" and "<invoke" in b.get("text", "")
                     for b in (blocks(_last_asst) if _last_asst else []))
    log(f"ENTRY ch={channel} msgs={len(msgs)} last_sr={_last_sr} last_invoke_text={_last_leak}")

    # ── LAYER 1: re-send any WELL-FORMED reply the model leaked as <invoke> text ──
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
            if send_via_daemon(port, channel, chat_id, text):
                state_add(statefile, key); seen.add(key)
                log(f"re-sent leaked reply ch={channel} chat={chat_id} len={len(text)}")
        return 0  # handled a well-formed leak this turn → answered, do not also nudge/notice

    # ── LAYER 2: ensure the owner's last message got answered, else nudge → notice ──
    owner_idx = [i for i, m in enumerate(msgs) if is_owner_msg(m)]
    if not owner_idx:
        return 0
    oi = owner_idx[-1]
    owner_text = ""
    for b in blocks(msgs[oi]):
        if isinstance(b, dict) and b.get("type") == "text":
            owner_text = b.get("text", "")

    # Scan everything since the owner spoke. parse-error can surface in a synthetic USER
    # message ("…could not be parsed…"), so check text in BOTH roles for it.
    has_reply = parse_err = malformed = leak_seen = False
    best = ""
    for m in msgs[oi + 1:]:
        role = m.get("role")
        if role == "assistant" and m.get("_apierr"):
            parse_err = True
        for b in blocks(m):
            if not isinstance(b, dict):
                continue
            if role == "assistant" and b.get("type") == "tool_use" and str(b.get("name", "")).endswith("reply"):
                has_reply = True
            elif b.get("type") == "text":
                txt = b.get("text", "")
                if PARSE_ERR in txt:
                    parse_err = True
                if role == "assistant":
                    if LEAK_RE.search(txt):
                        leak_seen = True            # well-formed leak → layer-1 territory (answered)
                    elif REPLY_LEAK_TAG.search(txt):
                        malformed = True            # reply tag as text we can't extract
                    is_special = (PARSE_ERR in txt) or LEAK_RE.search(txt) or REPLY_LEAK_TAG.search(txt)
                    if not is_special and len(txt) > len(best):
                        best = txt

    # Answered: a real reply tool call, or a well-formed leak (layer 1 delivers it) → done.
    if has_reply or leak_seen:
        return 0

    # Classify the failure → pick nudge budget + notice (malformed is more specific than a
    # bare parse-error; a clean ≥TEXT_MIN terminal answer = forgot; nothing substantive = silent).
    if malformed:
        ftype = "malformed"
    elif parse_err:
        ftype = "parse_error"
    elif len(best) >= TEXT_MIN:
        ftype = "forgot"
    else:
        ftype = "silent"

    mm = re.search(r'message_id="([^"]+)"', owner_text)
    mid = mm.group(1) if mm else hashlib.sha256(owner_text.encode()).hexdigest()[:16]
    prefix = f"{session_id}|{mid}"
    nfile = os.path.join(KA_HOME, "reply-safety-nudged.txt")
    done = nudges_done(nfile, prefix)
    budget = NUDGE_BUDGET[ftype]

    # Still have nudge budget → re-engage the model for one more turn.
    if done < budget:
        k = done + 1
        state_add(nfile, f"{prefix}|{k}")
        log(f"nudge #{k}/{budget} ({ftype}) owner msg {mid} → decision:block")
        print(json.dumps({"decision": "block", "reason": NUDGE_REASON[ftype]}))
        return 0

    # Budget exhausted → send EXACTLY ONE hook notice (model-independent, fixed text), then
    # stop. This is the north-star floor: the owner always gets the answer OR this notice.
    notified = os.path.join(KA_HOME, "reply-safety-notified.txt")
    if prefix in state_load(notified):
        log(f"already noticed owner msg {mid} ({ftype}); nothing more (no loop)")
        return 0
    cm = CHAT_ID_RE.search(owner_text)
    if not cm:
        log(f"notice ({ftype}) owner msg {mid}: no chat_id in meta — cannot address; giving up")
        return 0
    if send_via_daemon(port, channel, cm.group(1), NOTICE[ftype]):
        state_add(notified, prefix)
        log(f"notice ({ftype}) sent for owner msg {mid} after {done} nudge(s)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
