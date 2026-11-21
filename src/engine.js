// One pass over the account: find comments that match a rule and haven't been
// answered, DM the commenter, then reply publicly under the comment.
//
// There is no database. A comment counts as handled once our own account has
// replied under it, so the public reply is both the customer-facing "Sent you
// a DM!" and the marker that stops a second DM. Instagram itself also refuses
// a second private reply to the same comment.

import { matchRule } from "./match.js";

const DAY = 24 * 60 * 60 * 1000;
// Instagram's private-reply window is 7 days from the comment. Stop a little short of it.
export const REPLY_WINDOW_MS = 7 * DAY - 60 * 60 * 1000;

const sameUser = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** Picks a public reply so the same line isn't posted under every comment (stable per comment). */
export function pickReply(replies, commentId) {
  let sum = 0;
  for (const ch of String(commentId)) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
  return replies[sum % replies.length];
}

/**
 * @param {object} deps
 * @param {object} deps.api            client from instagram.js
 * @param {object[]} deps.rules        validated rules
 * @param {object} [deps.options]
 * @param {boolean} [deps.options.dryRun]      log what would be sent, send nothing
 * @param {number}  [deps.options.mediaLimit]  how many recent posts to check (default 25)
 * @param {number}  [deps.options.maxActions]  cap on comments answered per run (default 40)
 * @param {Date}    [deps.options.ignoreBefore] never answer comments older than this (go-live time)
 * @param {Date}    [deps.options.now]
 * @param {(line: string) => void} [deps.log]
 */
export async function runOnce({ api, rules, options = {}, log = console.log }) {
  const { dryRun = false, mediaLimit = 25, maxActions = 40, ignoreBefore = null, now = new Date() } = options;
  const summary = { checkedMedia: 0, checkedComments: 0, matched: 0, dmSent: 0, replied: 0, fallback: 0, deferred: 0, skippedOld: 0, errors: [] };

  const me = await api.me();
  const dmedThisRun = new Set();
  let actions = 0;

  const media = await api.recentMedia(mediaLimit);
  for (const item of media) {
    if (!item.comments_count) continue;
    let comments;
    try {
      comments = await api.comments(item.id);
    } catch (err) {
      if (err.kind === "auth") throw err;
      summary.errors.push(`comments on ${item.id}: ${err.message}`);
      continue;
    }
    summary.checkedMedia++;

    for (const c of comments) {
      summary.checkedComments++;
      if (sameUser(c.username, me.username)) continue;
      const rule = matchRule(c.text, rules);
      if (!rule) continue;
      if ((c.replies?.data ?? []).some((r) => sameUser(r.username, me.username))) continue; // already answered

      const at = new Date(c.timestamp);
      if (now - at > REPLY_WINDOW_MS || (ignoreBefore && at < ignoreBefore)) {
        summary.skippedOld++;
        continue;
      }
      summary.matched++;
      if (actions >= maxActions) { summary.deferred++; continue; }
      actions++;

      const who = `@${c.username ?? "unknown"}`;
      const publicText = pickReply(rule.publicReplies, c.id);
      if (dryRun) {
        log(`[dry run] ${rule.name}: would DM ${who} and reply "${publicText}" (comment ${c.id}: ${JSON.stringify(c.text)})`);
        continue;
      }

      // 1. The DM. One per person per run, even if they commented twice.
      let dmOk = dmedThisRun.has(c.username);
      if (!dmOk) {
        try {
          await api.privateReply(c.id, rule.dm);
          dmOk = true;
          dmedThisRun.add(c.username);
          summary.dmSent++;
        } catch (err) {
          if (err.kind === "auth") throw err;
          if (err.kind === "transient") {
            // Leave the comment unanswered so the next run tries again.
            summary.deferred++;
            summary.errors.push(`DM to ${who} deferred: ${err.message}`);
            continue;
          }
          // Permanent: they can't be DMed (or this comment was already DMed). Say so publicly instead.
          summary.errors.push(`DM to ${who} failed (code ${err.code ?? "?"}): ${err.message}`);
        }
      }

      // 2. The public reply, which also marks the comment as handled.
      const text = dmOk ? publicText : rule.fallbackReply;
      let posted = false;
      for (let attempt = 0; attempt < 2 && !posted; attempt++) {
        try {
          await api.publicReply(c.id, text);
          posted = true;
        } catch (err) {
          if (err.kind === "auth") throw err;
          if (attempt === 1) summary.errors.push(`public reply to ${who} failed: ${err.message}`);
        }
      }
      if (posted) dmOk ? summary.replied++ : summary.fallback++;
      log(`${rule.name}: ${who} -> DM ${dmOk ? "sent" : "FAILED"}, public reply ${posted ? `"${text}"` : "FAILED"}`);
    }
  }
  return summary;
}
