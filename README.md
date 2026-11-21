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

Every 5 minutes Echo reads the comments on the 25 most recent posts and answers any that match a rule. There is no database. Two checks stop anyone being messaged twice:

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
npm test                                   # 24 tests, no network
IG_ACCESS_TOKEN=... npm run dry-run        # shows what it would send, sends nothing
IG_ACCESS_TOKEN=... npm start              # sends
```

Settings (environment): `IG_ACCESS_TOKEN` (required), `DRY_RUN`, `DIAGNOSE`, `HISTORY_CHECK`, `IGNORE_BEFORE` (ISO time), `MEDIA_LIMIT` (25), `MAX_ACTIONS` (40 per run), `IG_API_VERSION` (v25.0).

## Set-up (done 21 Nov 2026)

- **Meta app:** "Reverse Marketing" (app ID 2021787335883788), use case "Manage messaging & content on Instagram", API setup with Instagram login, with `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages`. @enter.reverse is added as an Instagram Tester.
- **Token:** generated on that page for @enter.reverse and stored as the `IG_ACCESS_TOKEN` Actions secret in this repo.

**The token lasts 60 days (until about 20 Jan 2027).** Before then, generate a new one on the same Meta page and update the secret; automatic refresh is not built. Meta now labels Instagram login "legacy" and recommends "Unified login", whose system-user token does not expire. Moving Echo to it is the planned fix.

## Where it runs

GitHub Actions, `.github/workflows/reply.yml`, every 5 minutes (GitHub often starts scheduled runs late, so expect 5 to 15 minutes from comment to DM). A daily `keepalive` job re-enables the workflow, because GitHub switches off schedules in public repos after 60 days without a commit. The schedule only runs while the repo is public; the reason is in the workflow's header comment. Actions → reply → Run workflow does a pass by hand, with a dry-run tick box and a diagnose option.

## Running on Cloudflare instead (built, not switched on)

GitHub's timer did not fire once on this repo in its first hours, so the same pass is also packaged as a Cloudflare Worker (`worker/`), which Cloudflare starts every minute. It is not live until someone connects a Cloudflare account:

1. Create a free Cloudflare account.
2. Add two Actions secrets to this repo: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (a token made from Cloudflare's "Edit Cloudflare Workers" template).
3. Run Actions → deploy-worker. It deploys the Worker in dry-run mode and copies `IG_ACCESS_TOKEN` across.
4. Read the Worker's logs for a few minutes, then set `DRY_RUN = "0"` in `worker/wrangler.toml` to go live, and in the same change remove the `schedule:` block from `reply.yml`, so the two timers never both send.

The free plan allows 50 outgoing calls per run, so each pass is capped (20 posts, 6 DM-thread reads, 5 sends); anything over that is handled a minute later.

## What would stop it

| Cause | What you'd see | Fix |
|---|---|---|
| Token expired (about 20 Jan 2027) or revoked | Every run fails with "Instagram rejected the access token" | Generate a new token on the Meta page, update the `IG_ACCESS_TOKEN` secret |
| Repo made private | Scheduled runs show as skipped | Make it public again, or move the runner |
| @enter.reverse removed as Instagram Tester, or a permission removed from the Meta app | Runs fail or warn on every comment | Restore the role or permission, generate a new token |
| Meta retires "Instagram login" (it is already labelled legacy) | Runs start failing | Move Echo to Unified login |
| A broken edit to `rules.json` | Run fails at "Check rules.json", nothing is sent | Fix the file; `npm run check` validates it |

Nothing alerts anyone when runs fail. Check the Actions tab, or set up a daily check.

## Limits

- **Polling, not instant.** Instagram only pushes comments to apps that have passed App Review (Advanced Access). Until then Echo checks on a timer, so the DM lands a few minutes after the comment rather than within seconds.
- **Instagram only.** TikTok has no API for replying to comments.
- **Replies inside threads.** A "TRIAL" written as a reply under someone else's comment should also get the DM, since Instagram lists replies alongside comments, but this has not been seen on the live account yet.
- **One-word comments only.** "trial please" or "TRIAL @friend" gets nothing. That is deliberate (see `match` above), but it does mean near-misses are left for a person to answer.
- **DM history goes back 20 messages.** Instagram only lets Echo read the 20 most recent messages in a thread. Someone who got the link, then exchanged more than 20 messages with us, then commented TRIAL again would be sent it again.
- **Big reels.** Echo reads up to 1,000 comments per post per run, newest first, stopping at the 7-day mark.
- **Organic posts only.** Comments on ads that aren't also on the profile grid are not in the list Echo reads.
- **Reading is proven on the live account; sending is not yet.** Dry runs on 21 Nov 2026 read comments, replies and DM threads correctly. The first real DM and public reply will be the test of the two sending calls.
