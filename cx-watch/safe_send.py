#!/usr/bin/env python3
"""Send a settled-answer reply without asking, after a hold (the user, 21 Nov 9:22pm:
"whatever has already been rectified ... you have controls"; anything unsure gets flagged).

Usage: safe_send.py <conversation id> <id of the customer message being answered> <file with the reply>

Waits HOLD seconds (90), then sends only if the chat's last public message is still that customer
message: nobody on the team replied in the meantime, and the customer didn't add anything new
(a new message may change the answer, so it goes back to Claude). Logs every outcome to
autosent.log as SAFE-SENT / SAFE-SKIP, so it shows in the board and the 5:30pm handover."""
import sys, time, datetime
sys.path.insert(0, "/tmp/claude-0/-home-claude/6b4c8af7-04f8-58a4-aae7-b3cdc76acd22/scratchpad/watch")
import autoreply as a

HOLD = 90  # 1 min 30 s (the user, 22 Nov 11:21pm; was 3 min)
cid, answering, path = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
text = open(path).read().strip()
time.sleep(HOLD)
pub = [m for m in a._req(f"/conversations/{cid}/messages")["payload"] if m["message_type"] in (0, 1) and not m.get("private")]
stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%d %b %H:%M")
# Cloudflare's automatic replies (claim, TRIAL, Red Light ad, thank-you) don't count as "the team replied":
# a question sent with the claim was skipped at 1:14am on 23 Nov because the claim reply landed after it.
AUTO = ("you're in!", "you're both in!", "your trial pass is here", "i'm zoey from reverse", "you're welcome! always happy to help")
target = next((m for m in pub if m["id"] == answering), None)
after = [m for m in pub if target and m["id"] > answering]
newer_cust = [m for m in after if m["message_type"] == 0]
team = [m for m in after if m["message_type"] == 1 and not any(k in (m.get("content") or "").lower()[:80] for k in AUTO)]
if not target or newer_cust or team:
    why = "customer wrote again" if newer_cust else "team replied" if team else "message not found"
    line = f"{stamp} SAFE-SKIP {cid}: {why}, not sent"
else:
    try:
        mid, status = a.send_and_check(cid, text)
        line = f"{stamp} SAFE-SENT {cid} (msg {mid}, {status}) | {text[:120].replace(chr(10), ' ')}"
    except a.Blocked as e:
        line = f"{stamp} SAFE-BLOCKED {cid}: {e} | not sent, flag it to the user"
open(a.LOG, "a").write(line + "\n")
print(line)
