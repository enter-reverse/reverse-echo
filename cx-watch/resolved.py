#!/usr/bin/env python3
"""Tell the team a flagged case is done, as a WhatsApp reply to the original flag message
(the user, 22 Nov 13:41). Usage: resolved.py <customer conversation id> <one line on what happened>
Replies to every open flag recorded for that conversation in alerts.json, then marks them closed.
A team chat whose 24-hour window is closed is skipped and reported."""
import sys, json, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import autoreply as a

STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "alerts.json")
# --sent: a reply went to the customer on a flagged case (the user, 22 Nov 16:05: "send everyone in the team the
# response ... sent"). Posts it under the flag as an update and leaves the flag open.
sent = "--sent" in sys.argv
args = [x for x in sys.argv[1:] if x != "--sent"]
cid, what = args[0], " ".join(args[1:]).strip()
store = json.load(open(STORE)) if os.path.exists(STORE) else {}
open_flags = [f for f in store.get(cid, []) if f.get("open")]
if not open_flags:
    print(f"no open flag recorded for conversation {cid}"); sys.exit(0)
# One resolved reply per team chat, under the latest flag; earlier flags for the same case close quietly
# (the user, 22 Nov 14:34: two flags for one customer gave a double update).
latest = {}
for f in open_flags:
    if f["team_conv"] not in latest or f["at"] > latest[f["team_conv"]]["at"]:
        latest[f["team_conv"]] = f
if not sent:
    for f in open_flags:
        if f is not latest[f["team_conv"]]:
            f["open"] = False
for f in latest.values():
    if not a._req(f"/conversations/{f['team_conv']}").get("can_reply", True):
        print(f"conv {f['team_conv']}: CLOSED window, not sent"); continue
    r = a._req(f"/conversations/{f['team_conv']}/messages",
               {"content": f"↪️ Sent to the customer:\n\n{what}" if sent else f"✅ Resolved: {what}", "message_type": "outgoing", "private": False,
                "content_attributes": {"in_reply_to": f["msg"]}})
    if not sent: f["open"] = False
    print(f"conv {f['team_conv']}: sent {'update' if sent else 'resolved'} reply (msg {r.get('id')}) to flag {f['msg']}")
json.dump(store, open(STORE, "w"), indent=1)
