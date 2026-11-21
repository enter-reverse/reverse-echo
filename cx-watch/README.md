# CX watch

The customer-chat watcher Claude runs for Reverse's Chatwoot inbox (WhatsApp, Instagram, Messenger, email, web chat).
It is a copy kept here for reference: it runs in a Claude session, not from this repo or its Actions.

This repo is public, so these files hold no tokens and no customer data. The Chatwoot token and account id are read at
run time from an `env` file outside the repo (`CW_TOKEN`, `CW_ACC`). The paths in the files point at the session's
workspace; change them to run it elsewhere.

## Files

| File | What it does |
| --- | --- |
| `monitor.py` | Polls Chatwoot every 30 seconds and exits with a line per event: a new customer message, our reply (and how long it took), a chat unanswered at 10 and again at 20 minutes, and a claim follow-up that is due (day 1, 3 or 5, with day 1 pulled forward so it lands inside WhatsApp's 24-hour window). It skips the Joo Chiat store's WhatsApp and newsletter or receipt emails. |
| `autoreply.py` | The reply templates and the sender. Fresh website claims (HBOT, Red Light, Contrast, Dry Float, Duo) and "TRIAL" messages get their template at once; `send_and_check` sends and reads back delivery. |
| `safe_send.py` | Sends a reply to a question the CX playbook already settles, after a 3-minute hold, only if nobody on the team replied and the customer added nothing. Every outcome is logged. |
| `dashboard.py` | Builds the CX Board's data: chats waiting on us, and each claimer's follow-up stage. |
| `slots.sql` | Free slots per room for a day, from the Mindbody bookings Olympus keeps (the hourly copy plus live webhooks). Run it in Olympus with `:DAY` replaced by a date. |

## Rules it follows

The replies and what may go out without a person's go are set in the Claimer follow-up playbook (the CX playbook).
Anything sensitive (health, complaints, refunds, bookings, partnerships) is only ever flagged to a person.

Not copied: the working data (claims, notes, the watcher's state, the send log, the board's JSON), which name
customers, and the retired `autoclaim.py`, which `autoreply.py` replaced.
