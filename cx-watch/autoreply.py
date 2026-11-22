"""Auto-replies the user approved (20 Nov, 12:03pm: "for trial messages js auto reply. claims too").
Only two kinds, and only when we have never written to that conversation:
- TRIAL: a message that is just "trial" (any case, punctuation) -> the trial-pass reply with /gift
- claims: the site's WhatsApp claim button text -> the playbook's claim reply (templates from autoclaim.py)
Everything else stays draft-for-"send"."""
import json, re, time, urllib.request

def _env():
    e = dict(l.strip().split("=", 1) for l in open(
        "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/chatwoot/env") if "=" in l)
    return e["CW_TOKEN"].strip('"'), e["CW_ACC"].strip('"')

TOK, ACC = _env()
BASE = f"https://app.chatwoot.com/api/v1/accounts/{ACC}"
LOG = "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch/autosent.log"

TAIL = ("- $199 for your first month, then $299 a month\n"
        "- 10 credits a month from month 4, same price\n\n"
        "Any questions, just ask me here :)\n\n- Zoey")  # no booking offer (the user, 21 Nov 8:13pm)

def first_name(n):
    w = (n or "").strip().split()
    w = w[0] if w else ""
    if not re.fullmatch(r"[A-Za-z][A-Za-z'\-]{1,20}", w): return ""
    return w[0].upper() + w[1:] if w.islower() else w  # "jenny" -> "Jenny" (the user, 21 Nov)

def tpl(kind, name):
    hey = f"Hey {name}!" if name else "Hey!"
    hi = f"Hi {name}" if name else "Hi"
    if kind == "trial":
        return (f"{hey} Your trial pass is here: your first month is $199 instead of $299, with the $100 off already applied.\n\n"
                "https://pass.enterreverse.com/gift\n\n"
                "That's 8 credits to use across HBOT, Red Light, Contrast and Dry Float, then $299 a month after, no commitment. "
                "Any questions, just ask me here :)\n\n- Zoey")
    if kind == "hbot":
        return (f"{hi}, you're in! Here's your $199 first month, with your $100 off already applied:\n\n"
                "https://pass.enterreverse.com/gift\n\nWhat you get:\n"
                "- 8 credits a month, enough for 4 HBOT sessions at 2.0 ATA (55 minutes each)\n"
                "- Use your credits on any therapy at Reverse too: Red Light, Dry Float and Contrast\n" + TAIL)
    if kind == "red":
        return (f"{hi}, you're in! Here's your $199 first month, with your $100 off already applied:\n\n"
                "https://pass.enterreverse.com/gift\n\nWhat you get:\n"
                "- 8 credits a month, enough for 8 Red Light sessions\n"
                "- Use your credits on any therapy at Reverse too: HBOT, Dry Float and Contrast\n" + TAIL)
    if kind == "float":
        return (f"{hi}, you're in! Here's your $199 first month, with your $100 off already applied:\n\n"
                "https://pass.enterreverse.com/gift\n\nWhat you get:\n"
                "- 8 credits a month, enough for 8 Dry Float sessions (50 minutes each)\n"
                "- Use your credits on any therapy at Reverse too: HBOT, Red Light and Contrast\n" + TAIL)
    if kind == "contrast":  # same shape as every therapy (the user, 22 Nov); drop-ins only when asked
        return (f"{hi}, you're in! Here's your $199 first month, with your $100 off already applied:\n\n"
                "https://pass.enterreverse.com/gift\n\nWhat you get:\n"
                "- 8 credits a month, enough for 4 Contrast sessions (75 minutes each, up to 4 people)\n"
                "- Use your credits on any therapy at Reverse too: HBOT, Red Light and Dry Float\n" + TAIL)
    if kind == "duo":
        return (f"{hi}, you're both in! Here's your $299 first month for two, with your $299 off already applied:\n\n"
                "https://pass.enterreverse.com/gift-duo\n\nWhat you get:\n"
                "- 16 credits a month between you (8 each), enough for 4 HBOT sessions each at 2.0 ATA (55 minutes)\n"
                "- Use your credits on any therapy at Reverse too: Red Light, Dry Float and Contrast\n"
                "- $299 for your first month together, then $598 a month\n"
                "- 10 credits each a month from month 4, same price\n\n"
                "Any questions, just ask me here :)\n\n- Zoey")

def kind_of(text, inbox):
    t = (text or "").strip()
    if re.fullmatch(r"[\W_]*trial[\W_]*", t, re.I): return "trial"
    # Same inboxes and taps as Cloudflare's kindOf (cx-worker templates.js, PRs #29-#33): Instagram's chat-ad taps
    # are Cloudflare's to answer, so the watcher must skip them too, or a lead gets two replies (the user, 22 Nov 6:11pm).
    if inbox not in (156990, 157353, 156618): return None
    if re.match(r"^(Hi Reverse Team!? )?I['’]d like to (find out|know) more about the red ?light experience( at Reverse)?!?$", t, re.I): return "red_info"
    tap = re.match(r"^Hi Reverse Team!? I['’]d like to claim my \$\d+ off (HBOT|Red ?Light|Contrast|Dry Float)\.?$", t, re.I)
    if tap: return {"hbot": "hbot", "redlight": "red", "contrast": "contrast", "dryfloat": "float"}[tap.group(1).replace(" ", "").lower()]
    if re.match(r"^Hi Zoey! We'd like to claim our \$\d+ off HBOT for two", t): return "duo"
    m = re.match(r"^Hi Zoey! I'd like to claim my \$\d+ off (HBOT|Red Light|Contrast|Dry Float), \$\d+ for my first month\.", t)
    return {"HBOT": "hbot", "Red Light": "red", "Contrast": "contrast", "Dry Float": "float"}[m.group(1)] if m else None

def _req(path, data=None):
    h = {"api_access_token": TOK}
    if data is not None: h["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None, headers=h)
    return json.load(urllib.request.urlopen(r, timeout=30))

class Blocked(Exception):
    pass

def send_and_check(cid, content):
    """Post, wait, re-read the message's status. Returns (msg_id, status).
    Every customer send passes guard.check first (the user, 22 Nov 13:38): a blocked message raises Blocked and is not sent."""
    import guard
    why = guard.check(cid, content, _req)
    if why:
        raise Blocked("; ".join(why))
    try:
        r = _req(f"/conversations/{cid}/messages", {"content": content, "message_type": "outgoing", "private": False})
    except urllib.error.HTTPError as e:
        if e.code != 422: raise
        time.sleep(3)  # Chatwoot sometimes refuses a send once (22 Nov); one retry
        r = _req(f"/conversations/{cid}/messages", {"content": content, "message_type": "outgoing", "private": False})
    mid = r.get("id")
    status = r.get("status")
    for _ in range(4):
        time.sleep(5)
        for m in _req(f"/conversations/{cid}/messages")["payload"]:
            if m["id"] == mid: status = m.get("status")
        if status in ("delivered", "read", "failed"): break
    return mid, status

def maybe_reply(cid, inbox, name, msg, msgs):
    """msgs: the conversation's messages. Sends only if we have never written there. Returns a line or None."""
    k = kind_of(msg.get("content"), inbox)
    if not k or any(m["message_type"] == 1 for m in msgs): return None
    mid, status = send_and_check(cid, tpl(k, first_name(name)))
    line = f"AUTO-SENT {k} reply to {cid} {name} (msg {mid}, status {status})"
    open(LOG, "a").write(time.strftime("%d %b %H:%M ") + line + "\n")
    return line


def cloudflares(msg, msgs, inbox):
    """Whether Cloudflare answers this message, as its tick() decides (cx-worker cx.js), so the watcher leaves it
    alone; else it is Claude's. 'repeat' = an ad tap re-sent after its reply: nobody needs to answer.
    (The user, 22 Nov 6:23pm: simulate so there are no gaps. A TRIAL typed after the ad reply went unanswered.)"""
    k = kind_of(msg.get("content"), inbox)
    if not k: return False
    before = [x for x in msgs if x["created_at"] < msg["created_at"] or (x["created_at"] == msg["created_at"] and x["id"] < msg["id"])]
    if not any(x["message_type"] == 1 for x in before): return True  # a new chat: Cloudflare answers the first match
    tap = inbox == 156618 and (msg.get("content") or "").strip().lower().startswith("hi reverse team")
    if not tap: return False  # e.g. TRIAL typed mid-chat: Cloudflare stays out, so Claude answers
    opener = "Hey! I'm Zoey from Reverse. Our Redlight bed" if k == "red_info" else "Hi, you're in!"  # Cloudflare's nameless Instagram openers
    if any(x["message_type"] == 1 and (x.get("content") or "").startswith(opener) for x in before): return "repeat"
    return True

