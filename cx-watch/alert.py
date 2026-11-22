#!/usr/bin/env python3
"""WhatsApp an alert to the team about a case Claude can't or shouldn't handle (the user, 22 Nov 00:22:
"whatever can't be handled or is sensitive, message me and Dre on WhatsApp ... full details and quotation").

Usage: alert.py <file with the alert text> [customer conversation id]
With a conversation id, each alert message sent is recorded in alerts.json, so resolved.py can later reply to it
(the user, 22 Nov 13:41: when a flagged case is resolved, reply to the flag message saying so).
Sends to every team chat whose 24-hour window is open (the user messaged the CX number in the last 24 hours).
A chat whose window is closed needs the approved team_alert template; until then it's reported as CLOSED so
Claude falls back to email. Prints one line per person."""
import sys, time
sys.path.insert(0, "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch")
import autoreply as a

TEAM = {"Elijah": 410, "Andre": 94, "Gordon": 433}  # the team's chats with the CX number (Chatwoot conversation ids)
import json, os
text = open(sys.argv[1]).read().strip()
about = sys.argv[2] if len(sys.argv) > 2 else None
STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "alerts.json")
try: store = json.load(open(STORE))
except Exception: store = {}
for name, cid in TEAM.items():
    ms = [m for m in a._req(f"/conversations/{cid}/messages")["payload"] if m["message_type"] == 0]
    last = max((m["created_at"] for m in ms), default=0)
    if time.time() - last > 23.5 * 3600:
        print(f"{name}: CLOSED (last message {(time.time() - last) / 3600:.0f}h ago), needs the team_alert template or email")
        continue
    mid, status = a.send_and_check(cid, text)
    print(f"{name}: sent (msg {mid}, {status})")
    if about:
        store.setdefault(str(about), []).append({"team_conv": cid, "msg": mid, "at": time.time(), "open": True})
if about:
    json.dump(store, open(STORE, "w"), indent=1)
