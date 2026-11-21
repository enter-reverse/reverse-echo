#!/usr/bin/env python3
"""Send a settled-answer reply without asking, after a hold (the user, 21 Nov 9:22pm:
"whatever has already been rectified ... you have controls"; anything unsure gets flagged).

Usage: safe_send.py <conversation id> <id of the customer message being answered> <file with the reply>

Waits HOLD seconds, then sends only if the chat's last public message is still that customer
message: nobody on the team replied in the meantime, and the customer didn't add anything new
(a new message may change the answer, so it goes back to Claude). Logs every outcome to
autosent.log as SAFE-SENT / SAFE-SKIP, so it shows in the board and the 5:30pm handover."""
import sys, time, datetime
sys.path.insert(0, "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch")
import autoreply as a

HOLD = 180
cid, answering, path = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
text = open(path).read().strip()
time.sleep(HOLD)
pub = [m for m in a._req(f"/conversations/{cid}/messages")["payload"] if m["message_type"] in (0, 1) and not m.get("private")]
stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%d %b %H:%M")
last = pub[-1] if pub else {}
if last.get("id") != answering:
    why = "team replied" if last.get("message_type") == 1 else "customer wrote again"
    line = f"{stamp} SAFE-SKIP {cid}: {why}, not sent"
else:
    mid, status = a.send_and_check(cid, text)
    line = f"{stamp} SAFE-SENT {cid} (msg {mid}, {status}) | {text[:120].replace(chr(10), ' ')}"
open(a.LOG, "a").write(line + "\n")
print(line)
