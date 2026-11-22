#!/usr/bin/env python3
"""Monitor only (the user, 19 Nov 9:14am: Wendy is online, no auto-send). Sends nothing.
Reports, then exits so Claude can tell the user:
- a new customer message (who, what)
- our reply to a waiting customer, with how long it took
- a customer still unanswered after 10 minutes (late)"""
import json, sys, time, urllib.request, datetime
sys.path.insert(0, "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch")
import dashboard  # the CX pane's data (20 Nov)
import autoreply  # TRIAL and claim auto-replies (the user, 20 Nov 12:03pm)

ENV = "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/chatwoot/env"
env = dict(l.strip().split("=", 1) for l in open(ENV) if "=" in l)
B = f"https://app.chatwoot.com/api/v1/accounts/{env['CW_ACC']}"
TZ = datetime.timezone(datetime.timedelta(hours=8))
SINCE = int(sys.argv[1]) if len(sys.argv) > 1 else int(time.time())
STATE = "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch/monitor_state.json"
NOISE = ("noreply", "no-reply", "no_reply", "classpass", "intercom", "loops.so", "facebook", "anthropic", "openai",
         "n8n", "creativeos", "respond.io", "hello@enterreverse", "metamail", "claude.com", "netflix", "chatwoot",
         "youform", "shopify", "apple.com", "spotify", "google.com", "notifications", "mailer",
         "reallygoodemails", "paddle.com", "newsletter", "news@", "updates@", "info@")

TEAM = {158, 410, 94, 433}  # internal chats (Andre; 410 = the user, for alerts)

def get(p):
    r = urllib.request.Request(B + p, headers={"api_access_token": env["CW_TOKEN"]})
    return json.load(urllib.request.urlopen(r, timeout=30))

try: state = json.load(open(STATE))
except Exception: state = {"seen": [], "late": [], "answered": []}
t = lambda ts: datetime.datetime.fromtimestamp(ts, TZ).strftime("%H:%M")

while True:
    events = []
    try:
        convs = {}
        for s in ("open", "pending"):
            for c in get(f"/conversations?status={s}&assignee_type=all&page=1")["data"]["payload"]:
                convs[c["id"]] = c
        for cid, c in convs.items():
            if c["last_activity_at"] <= SINCE: continue
            if cid in (410, 94, 433):
                # Elijah's and Andre's chats with the Zoey number (the user, 22 Nov 14:57): their messages
                # (e.g. "any more messages to resolve?") come to Claude, who answers both with the open items.
                for m in get(f"/conversations/{cid}/messages")["payload"]:
                    if m["message_type"] == 0 and not m.get("private") and m["created_at"] > SINCE and m["id"] not in state["seen"]:
                        state["seen"].append(m["id"])
                        events.append(f"TEAM-MSG {cid} {c['meta']['sender'].get('name')} {t(m['created_at'])} | {(m.get('content') or '[attachment]')[:250].replace(chr(10), ' ')}")
                continue
            if cid in TEAM: continue
            if c["inbox_id"] == 157353: continue  # Joo Chiat WhatsApp: the store handles it (the user, 20 Nov 4:57pm)
            if c["inbox_id"] == 156786:
                em = (c["meta"]["sender"].get("email") or "").lower()
                if any(n in em for n in NOISE): continue
            name = c["meta"]["sender"].get("name")
            ms = [m for m in get(f"/conversations/{cid}/messages")["payload"] if m["message_type"] in (0, 1) and not m.get("private")]
            # customer messages since start that we haven't reported
            for m in ms:
                if m["message_type"] == 0 and m["created_at"] > SINCE and m["id"] not in state["seen"]:
                    state["seen"].append(m["id"])
                    # TRIAL and website claims: Cloudflare (reverse-echo cx-worker) is the only sender now
                    # (the user, 22 Nov 00:49). Track the claim for follow-ups, say nothing, send nothing.
                    if autoreply.kind_of(m.get("content"), c["inbox_id"]):
                        dashboard.add_claim(cid)
                        continue
                    events.append(f"NEW {cid} {name} {t(m['created_at'])} | {(m.get('content') or '[attachment]')[:250].replace(chr(10), ' ')}")
            # a TRIAL or claim Cloudflare still hasn't answered after 5 minutes: flag it
            for i, m in enumerate(ms):
                if m["message_type"] != 0 or not autoreply.kind_of(m.get("content"), c["inbox_id"]): continue
                if any(x["message_type"] == 1 for x in ms[i+1:]): continue
                age = time.time() - m["created_at"]
                if 300 < age < 6 * 3600 and m["id"] not in state.setdefault("noauto", []):
                    state["noauto"].append(m["id"])
                    # Cloudflare sends this alarm to the user's WhatsApp since 22 Nov 02:26 (the user); kept as a record only.
                    if False: events.append(f"NO AUTO-REPLY 5+ min {cid} {name} since {t(m['created_at'])}: Cloudflare hasn't answered | {(m.get('content') or '')[:150].replace(chr(10), ' ')}")
            # oldest customer message that is still waiting (no reply from us after it)
            waiting = None
            for m in ms:
                if m["message_type"] == 0: waiting = waiting or m
                else: waiting = None if waiting and m["created_at"] > waiting["created_at"] else waiting
            # replies: our first reply after a customer message we were tracking
            for i, m in enumerate(ms):
                if m["message_type"] != 0 or m["created_at"] <= SINCE: continue
                rep = next((x for x in ms[i+1:] if x["message_type"] == 1), None)
                key = f"{cid}:{m['id']}"
                prev_cust = i > 0 and ms[i-1]["message_type"] == 0
                if rep and key not in state["answered"] and not prev_cust:
                    state["answered"].append(key)
                    if autoreply.kind_of(m.get("content"), c["inbox_id"]): continue  # Cloudflare's auto-reply: no news
                    mins = round((rep["created_at"] - m["created_at"]) / 60)
                    events.append(f"REPLIED {cid} {name}: customer {t(m['created_at'])}, us {t(rep['created_at'])} ({mins} min, {'on time' if mins <= 10 else 'LATE'}) | {(rep.get('content') or '')[:150].replace(chr(10), ' ')}")
            # pings at 10 and 20 min unanswered (the user, 21 Nov 6:47pm: "ping if I forget to reply ... 10 minutes or 20 minutes")
            age = time.time() - waiting["created_at"] if waiting else 0
            for mins, key in ((20, "late2"), (10, "late")):
                if waiting and age > mins * 60 and age < 6 * 3600 and waiting["id"] not in state.setdefault(key, []) \
                        and not dashboard.answered_elsewhere(get, cid, name, waiting["created_at"]):
                    state["late"].append(waiting["id"]) if key == "late2" and waiting["id"] not in state["late"] else None
                    state[key].append(waiting["id"])
                    # Cloudflare sends the 10/20 min pings to the user's WhatsApp since 22 Nov 02:26 (the user); record only.
                    if False: events.append(f"UNANSWERED {mins}+ min {cid} {name} since {t(waiting['created_at'])} | {(waiting.get('content') or '[attachment]')[:200].replace(chr(10), ' ')}")
                    break
    except Exception as e:
        print("error:", e, flush=True)
    try: dashboard.build(get, convs, env["CW_ACC"].strip('"'), TEAM)
    except Exception as e: print("dashboard error:", e, flush=True)
    # claim follow-ups (the user, 21 Nov 7:11pm: "I need to keep tracking this. I keep forgetting"):
    # flag day 1/3/5 when due, or 4h before WhatsApp's 24h window would close first, whichever is earlier
    if time.time() - state.get("fu_checked", 0) > 600:
        state["fu_checked"] = time.time()
        try:
            for r in json.load(open(dashboard.OUT if hasattr(dashboard, "OUT") else "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch/dashboard.json"))["followups"]:
                s, key = r.get("next"), f"{r['id']}:d{r.get('next')}"
                if not s or key in state.setdefault("fu_alerted", []): continue
                if time.time() < r["claimedAt"] + 20 * 3600: continue
                labels = set(get(f"/conversations/{r['id']}").get("labels") or [])
                if labels & {"paid", "no-followup"}: continue
                # Cloudflare sends day 1 to WhatsApp claimers from 22 Nov 2:50pm (the user, 3:04pm); Claude keeps
                # day 1 only for Duo and Instagram/Messenger claimers, and days 3 and 5 for everyone.
                if s == 1 and r["channel"] == "WA CX" and "duo" not in labels: continue
                ms =[m for m in get(f"/conversations/{r['id']}/messages")["payload"] if m["message_type"] in (0, 1) and not m.get("private")]
                if not ms or ms[-1]["message_type"] == 0: continue  # they wrote last: that's a reply to answer, not a follow-up
                last_c = max(m["created_at"] for m in ms if m["message_type"] == 0)
                ig = r["channel"] == "Instagram"
                closes = last_c + (7 if ig else 1) * 86400
                if time.time() > closes: continue  # window shut: can't message
                due_at = r["claimedAt"] + s * 86400
                if time.time() >= (min(due_at, closes - 4 * 3600) if s == 1 else due_at):  # only day 1 is pulled forward by the closing window
                    state["fu_alerted"].append(key)
                    left = (closes - time.time()) / 3600
                    events.append(f"FOLLOWUP DUE day {s} {r['id']} {r['name']} ({r['channel']}), claimed {datetime.datetime.fromtimestamp(r['claimedAt'], TZ).strftime('%d %b %H:%M')}, window closes in {left:.1f}h")
        except Exception as e: print("followup error:", e, flush=True)
    json.dump(state, open(STATE, "w"))
    if events:
        print("\n".join(events)); sys.exit(0)
    time.sleep(30)
