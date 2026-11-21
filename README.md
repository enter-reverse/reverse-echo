# Echo

Reverse's own comment auto-responder for Instagram (@enter.reverse), in place of ManyChat.

When someone comments a keyword on a post or reel, Echo:

1. sends them the set DM for that keyword, and
2. replies under their comment ("Sent you a DM!").

Today there is one keyword, **TRIAL**, which sends the trial pass message with the `/gift` link.

## Change or add a reply

Everything it says lives in [`rules.json`](rules.json). Each rule is one keyword set and its replies:

```json
{
  "name": "trial",
  "keywords": ["trial"],
  "dm": "The message they get in their DMs.",
  "publicReplies": ["Sent you a DM!", "Check your DMs!"],
  "fallbackReply": "Posted instead when Instagram won't let us DM them."
}
```

- `keywords` match only when the comment is the keyword and nothing else, in any case, with any punctuation or emoji around it. "TRIAL", "trial", "Trial!!" and "trial 🙏" match. "trial please" and "can I get the trial?" do not, so people using the word in a sentence aren't messaged.
- Add `"match": "contains"` to a rule to match the keyword anywhere in a sentence instead.
- `publicReplies` are rotated so the same line isn't posted under every comment.
- To add a keyword (say, FLOAT), copy the block, change the five fields, and commit. Rules are checked in order and the first match wins.
- `npm run check` validates the file. A broken edit stops the run before anything is sent.

## How it works

Every minute Echo reads the comments on the 20 most recent posts and answers any that match a rule. There is no database. Two checks stop anyone being messaged twice:

1. **Our reply under the comment.** A comment that already has a reply from @enter.reverse is done. Instagram lists replies alongside comments and marks the ones the account wrote itself (a `user` field instead of `from`), so Echo knows which replies are ours. If a reply's author can't be resolved at all, it counts as ours and nothing is sent.
2. **The DM thread.** Before any DM, Echo reads the recent messages with that person. If we have already sent them this rule's message, whether by Echo, by hand or by the CX auto-reply, they get nothing more: no DM and no public reply. "This rule's message" means a message containing the first link in the rule's `dm` (or the rule's `sentMarker`, if set).

If either check can't be answered for certain, Echo sends nothing and tries again on the next run.

| Case | What happens |
|---|---|
| New TRIAL comment, never messaged | DM, then a public reply from `publicReplies` |
| Comment already has our reply | Skipped |
| Person already got this DM | Skipped: no DM, no public reply |
| Instagram won't deliver the DM (e.g. the person blocks message requests) | `fallbackReply` is posted instead |
| Rate limit, Instagram outage, or DM history unreadable | Nothing is sent; the next run tries again |
| Same person comments twice in one run | One DM, a public reply on each |
| Comment older than 7 days | Skipped (Instagram's limit for a DM to a commenter) |
| Comment older than `IGNORE_BEFORE` (optional) | Skipped |
| Access token rejected | The run stops and fails loudly |

Logs are public because the repo is public, so usernames are masked (`@ab…`) and message text is never logged.

## Run it

```sh
npm test                                   # 33 tests, no network
IG_ACCESS_TOKEN=... npm run dry-run        # shows what it would send, sends nothing
IG_ACCESS_TOKEN=... npm start              # sends
```

Settings (environment): `IG_ACCESS_TOKEN` (required), `DRY_RUN`, `DIAGNOSE`, `HISTORY_CHECK`, `IGNORE_BEFORE` (ISO time), `MEDIA_LIMIT` (25), `MAX_ACTIONS` (40 per run), `IG_API_VERSION` (v25.0).

## Set-up (done 21 Nov 2026)

- **Meta app:** "Reverse Marketing" (app ID 2021787335883788), use case "Manage messaging & content on Instagram", API setup with Instagram login, with `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages`. @enter.reverse is added as an Instagram Tester.
- **Token:** generated on that page for @enter.reverse and stored as the `IG_ACCESS_TOKEN` Actions secret in this repo.

**The token lasts 60 days (until about 20 Jan 2027).** Before then, generate a new one on the same Meta page and update the secret; automatic refresh is not built. Meta now labels Instagram login "legacy" and recommends "Unified login", whose system-user token does not expire. Moving Echo to it is the planned fix.

## Where it runs

On Cloudflare Workers (`worker/`), started every minute by Cloudflare's timer, so a DM goes out within about a minute of the comment. `deploy-worker.yml` deploys it whenever the Worker or the code it uses changes on main, and copies `IG_ACCESS_TOKEN` from this repo's Actions secrets into the Worker. The only Cloudflare secret here is `CLOUDFLARE_API_TOKEN`; the account id is in `worker/wrangler.toml`.

- **See what it is doing:** Actions → worker-logs → Run workflow, or the Worker's Logs tab in the Cloudflare dashboard.
- **Pause it:** set `DRY_RUN = "1"` in `worker/wrangler.toml` and merge; it keeps running but sends nothing.
- **Run a pass by hand:** Actions → reply → Run workflow (dry-run tick box, diagnose option). GitHub's own schedule was removed: it never fired on this repo, and two timers must never both send.

The free Cloudflare plan allows 50 outgoing calls per run, so each pass is capped (20 posts, 6 DM-thread reads, 5 sends); anything over that is handled a minute later.

## The CX watcher (`cx-worker/`, built, not switched on)

A second Worker that does the two things in customer chats that are pure templates, around the clock. It is a port of the watcher that ran inside the CX chat (`cx-watch/`), and its tests check every template against that script's own output.

- **Auto-replies.** A message that is just "TRIAL", or a claim from the website's WhatsApp button (HBOT, Red Light, Contrast, Dry Float, Duo), gets its reply within a minute, but only in a conversation we have never written in, and only if the message is under 15 minutes old.
- **Day-1 follow-up** (off until `FOLLOWUPS = "on"`). A WhatsApp claimer who has gone quiet gets the approved line about 20 hours in, before WhatsApp's 24-hour window closes. Skipped if they wrote last, if we already followed up, or if the conversation is labelled `paid`, `no-followup` or `duo`.

It keeps no database. Chatwoot labels are the record: `claim`, `trial`, `duo` say what a conversation is, `fu1` that the day-1 follow-up went, and a person can add `paid` or `no-followup` to stop it. Everything that needs judgment (drafting replies, the 10 and 20 minute pings, days 3 and 5, the CX Board) stays with the CX chat.

To switch it on: add the `CHATWOOT_TOKEN` and `CHATWOOT_ACCOUNT_ID` Actions secrets, run deploy-worker, read the Worker's logs in dry run, then set `DRY_RUN = "0"` in `cx-worker/wrangler.toml`. **In the same step, the CX chat's own watcher must stop auto-replying**, or both could answer the same customer. Turn `FOLLOWUPS` on only once paying customers are reliably being labelled `paid`.

## What would stop it

| Cause | What you'd see | Fix |
|---|---|---|
| Token expired (about 20 Jan 2027) or revoked | Every run fails with "Instagram rejected the access token" | Generate a new token on the Meta page, update the `IG_ACCESS_TOKEN` secret |
| Cloudflare token revoked or account closed | deploy-worker fails; the Worker stops updating or running | Create a new token (Edit Cloudflare Workers), update `CLOUDFLARE_API_TOKEN` |
| @enter.reverse removed as Instagram Tester, or a permission removed from the Meta app | Runs fail or warn on every comment | Restore the role or permission, generate a new token |
| Meta retires "Instagram login" (it is already labelled legacy) | Runs start failing | Move Echo to Unified login |
| A broken edit to `rules.json` | Run fails at "Check rules.json", nothing is sent | Fix the file; `npm run check` validates it |

Nothing alerts anyone when runs fail. Check the Actions tab, or set up a daily check.

## Limits

- **About a minute, not instant.** Instagram only pushes comments to apps that have passed App Review (Advanced Access). Until then Echo checks every minute.
- **Instagram only.** TikTok has no API for replying to comments.
- **Replies inside threads.** A "TRIAL" written as a reply under someone else's comment should also get the DM, since Instagram lists replies alongside comments, but this has not been seen on the live account yet.
- **One-word comments only.** "trial please" or "TRIAL @friend" gets nothing. That is deliberate (see `match` above), but it does mean near-misses are left for a person to answer.
- **DM history goes back 20 messages.** Instagram only lets Echo read the 20 most recent messages in a thread. Someone who got the link, then exchanged more than 20 messages with us, then commented TRIAL again would be sent it again.
- **Big reels.** Echo reads up to 1,000 comments per post per run, newest first, stopping at the 7-day mark.
- **Organic posts only.** Comments on ads that aren't also on the profile grid are not in the list Echo reads.
- **Reading is proven on the live account; sending is not yet.** Dry runs on 21 Nov 2026 read comments, replies and DM threads correctly. The first real DM and public reply will be the test of the two sending calls.
