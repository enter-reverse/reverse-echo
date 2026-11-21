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

- `keywords` match as whole words, in any case, with any punctuation or emoji around them. "TRIAL", "trial!!" and "can I get the trial? 🙏" match; "trials" does not.
- `publicReplies` are rotated so the same line isn't posted under every comment.
- To add a keyword (say, FLOAT), copy the block, change the five fields, and commit. Rules are checked in order and the first match wins.
- `npm run check` validates the file. A broken edit stops the run before anything is sent.

## How it works

Each run reads the comments on the 25 most recent posts and answers any that match a rule and have no reply from us yet. There is no database: our public reply is what marks a comment as done, so a comment is never DMed twice, and Instagram itself refuses a second DM to the same comment.

| Case | What happens |
|---|---|
| DM sent | Public reply from `publicReplies` |
| Instagram won't deliver the DM (e.g. the person blocks message requests) | `fallbackReply` is posted instead |
| Rate limit or Instagram outage | Nothing is posted; the next run tries again |
| Same person comments twice in one run | One DM, a public reply on each |
| Comment older than 7 days | Skipped (Instagram's limit for a DM to a commenter) |
| Comment older than `IGNORE_BEFORE` | Skipped, so go-live doesn't re-message people already handled by hand |
| Access token rejected | The run stops and fails loudly |

## Run it

```sh
npm test                                   # 19 tests, no network
IG_ACCESS_TOKEN=... npm run dry-run        # shows what it would send, sends nothing
IG_ACCESS_TOKEN=... npm start              # sends
```

Settings (environment): `IG_ACCESS_TOKEN` (required), `DRY_RUN`, `IGNORE_BEFORE` (ISO time), `MEDIA_LIMIT` (25), `MAX_ACTIONS` (40 per run), `IG_API_VERSION` (v25.0).

## Set-up, once

1. **Meta app.** At developers.facebook.com create an app with the Instagram product ("API setup with Instagram login"), with the permissions `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages`. The app can stay at Standard Access because it only serves our own account.
2. **Token.** In that app's "Generate access tokens" section, add the @enter.reverse account and copy the token.
3. **Secret.** Save it as the `IG_ACCESS_TOKEN` Actions secret in this repo, and set the `IGNORE_BEFORE` variable to the go-live time.
4. **Dry run.** Actions → reply → Run workflow with "dry run" ticked, and read the log.

The token lasts 60 days. It has to be refreshed or regenerated before then; automatic refresh is not built yet.

## Where it runs

`.github/workflows/reply.yml` runs a pass by hand today. Its schedule is switched off, because a private repo polling every 5 minutes would use about 8,640 Actions minutes a month against the organisation's 2,000. The choices are in the workflow's header comment: make this repo public, or run the same `src/cli.js` on a host with a per-minute timer.

## Limits

- **Polling, not instant.** Instagram only pushes comments to apps that have passed App Review (Advanced Access). Until then Echo checks on a timer, so the DM lands a few minutes after the comment rather than within seconds.
- **Instagram only.** TikTok has no API for replying to comments.
- **Top-level comments only.** A "TRIAL" written as a reply inside someone else's thread is not picked up.
- **Organic posts only.** Comments on ads that aren't also on the profile grid are not in the list Echo reads.
- **Not yet run against the live account.** The Instagram calls follow Meta's documentation and are tested against a fake; the first dry run with a real token is the real test.
