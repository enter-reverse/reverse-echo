"""Writes dashboard.json for the CX pane (the user, 20 Nov 2:37pm): open threads where the customer spoke last,
and claimers due a follow-up (day 1, 3, 5). notes.json (kept by Claude) adds what each thread needs, or hides it."""
import json, os, time

W = "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch"
OUT, NOTES, CLAIMS = f"{W}/dashboard.json", f"{W}/notes.json", f"{W}/claims.json"
INBOX = {156618: "Instagram", 157353: "WA Joo Chiat", 156990: "WA CX", 156616: "Messenger", 156786: "Email", 156615: "Web"}
NOISE = ("noreply", "paddle.com", "no-reply", "no_reply", "classpass", "mindbody", "intercom", "loops", "facebook", "shopify", "google",
         "notifications", "mailer", "newsletter", "hello@enterreverse", "anthropic", "apple.com", "youform", "chatwoot")
_fu = {"at": 0, "rows": []}
_out = {"at": 0, "msgs": []}  # our recent messages in every inbox, to spot a reply sent from another chat

def _refresh_out(get):
    now = time.time()
    if now - _out["at"] < 120: return
    msgs, seen = [], set()
    for st in ("open", "pending", "resolved"):
        try: page = get(f"/conversations?status={st}&assignee_type=all&page=1")["data"]["payload"]
        except Exception: continue
        for c in page:
            if c["id"] in seen or c["last_activity_at"] < now - 86400: continue
            seen.add(c["id"])
            try:
                for m in get(f"/conversations/{c['id']}/messages")["payload"]:
                    if m["message_type"] == 1 and not m.get("private") and m["created_at"] > now - 86400:
                        msgs.append((c["id"], m["created_at"], (m.get("content") or "").lower()))
            except Exception: pass
    _out.update(at=now, msgs=msgs)

def answered_elsewhere(get, cid, name, since):
    """True when we wrote to this person by first name in another chat after `since` (the team often replies from
    the store's WhatsApp, which Chatwoot files as a different contact)."""
    import re
    first = re.sub(r"[^a-z]", "", (name or "").split()[0].lower()) if (name or "").split() else ""
    if len(first) < 3: return False
    _refresh_out(get)
    return any(c != cid and t > since and re.search(r"\b" + first + r"\b", txt) for c, t, txt in _out["msgs"])

def _load(p, d):
    try: return json.load(open(p))
    except Exception: return d

def _write(p, obj):
    tmp = p + ".tmp"
    json.dump(obj, open(tmp, "w")); os.replace(tmp, p)

def add_claim(cid):
    c = _load(CLAIMS, [])
    if cid not in c: c.append(cid); _write(CLAIMS, c)

def _msgs(get, cid):
    return [m for m in get(f"/conversations/{cid}/messages")["payload"] if m["message_type"] in (0, 1) and not m.get("private")]

def _followups(get, notes):
    now, rows = time.time(), []
    for cid in _load(CLAIMS, []):
        n = notes.get(str(cid), {})
        if n.get("paid") or n.get("stop"): continue
        try:
            c = get(f"/conversations/{cid}"); ms = _msgs(get, cid)
        except Exception: continue
        if c["inbox_id"] == 157353: continue
        cust = [m for m in ms if m["message_type"] == 0]
        if not cust: continue
        t0 = cust[0]["created_at"]
        ours = [m["created_at"] for m in ms if m["message_type"] == 1]
        done = [d for d in (1, 3, 5) if any(t >= t0 + (d - 0.5) * 86400 for t in ours)]
        due = next((d for d in (1, 3, 5) if d not in done and now >= t0 + d * 86400 and not any(x > d for x in done)), None)
        nxt = next((d for d in (1, 3, 5) if d not in done and not any(x > d for x in done)), None)
        rows.append({"id": cid, "name": c["meta"]["sender"].get("name") or "?", "channel": INBOX.get(c["inbox_id"], "?"),
                     "claimedAt": t0, "done": done, "due": due, "next": nxt,
                     "nextAt": t0 + nxt * 86400 if nxt else None, "note": n.get("note", "")})
    rows.sort(key=lambda r: (r["due"] is None, r["nextAt"] or 9e12))
    return rows

def build(get, convs, acc=None, team=(158,)):
    notes = _load(NOTES, {})
    now, threads = time.time(), []
    for cid, c in convs.items():
        if cid in team or c["last_activity_at"] < now - 3 * 86400: continue
        if c["inbox_id"] == 157353: continue  # store-run, not tracked
        n = notes.get(str(cid), {})
        if c["inbox_id"] == 156786:
            em = (c["meta"]["sender"].get("email") or "").lower()
            if any(x in em for x in NOISE): continue
        m = c.get("last_non_activity_message") or {}
        if m.get("message_type") != 0 or m.get("private"): continue
        if n.get("hide") and n.get("hideUntil", 0) >= m.get("created_at", 0): continue
        if answered_elsewhere(get, cid, c["meta"]["sender"].get("name"), m.get("created_at", 0)): continue
        threads.append({"id": cid, "name": c["meta"]["sender"].get("name") or "?", "channel": INBOX.get(c["inbox_id"], "?"),
                        "since": m.get("created_at"), "text": (m.get("content") or "[attachment]")[:140].replace("\n", " "),
                        "need": n.get("need", ""), "note": n.get("note", "")})
    threads.sort(key=lambda t: t["since"] or 0)
    if now - _fu["at"] > 300:
        try: _fu["rows"] = _followups(get, notes); _fu["at"] = now
        except Exception: pass
    _write(OUT, {"updatedAt": now, "account": acc, "threads": threads, "followups": _fu["rows"]})
