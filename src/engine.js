// One pass over the account: find comments that match a rule and haven't been
// answered, DM the commenter, then reply publicly under the comment.
//
// There is no database. Two things stop anyone being messaged twice:
//   1. A comment our own account has already replied under is done.
//   2. Before any DM, Echo reads the DM thread with that person. If we have
//      already sent them this rule's message (by Echo, by hand, or by the CX
//      auto-reply), they get nothing more: no DM and no public reply.
// When either check can't be answered for certain, Echo sends nothing and
// tries again on the next run.

import { matchRule } from "./match.js";

const DAY = 24 * 60 * 60 * 1000;
// Instagram's private-reply window is 7 days from the comment. Stop a little short of it.
export const REPLY_WINDOW_MS = 7 * DAY - 60 * 60 * 1000;

const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

/** Is this comment, reply or message written by the connected account? */
export function isOurs(item, me) {
  // `user` is only returned on comments the connected account wrote itself.
  const ids = [item?.from?.id, item?.user?.id, typeof item?.user === "object" ? null : item?.user].filter((x) => x != null);
  return (
    same(item?.username, me.username) ||
    same(item?.from?.username, me.username) ||
    ids.some((id) => same(id, me.id) || same(id, me.user_id))
  );
}

const hasAuthor = (item) => item?.username != null || item?.from?.id != null || item?.from?.username != null || item?.user != null;

/** What identifies "this rule's message" in a DM thread: `sentMarker`, else the first link in the DM, else its opening words. */
export function sentMarker(rule) {
  if (rule.sentMarker) return rule.sentMarker;
  const url = rule.dm.match(/https?:\/\/[^\s]+/);
  return url ? url[0] : rule.dm.slice(0, 40);
}

/** Picks a public reply so the same line isn't posted under every comment (stable per comment). */
export function pickReply(replies, commentId) {
  let sum = 0;
  for (const ch of String(commentId)) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
  return replies[sum % replies.length];
}

/** "@ab…" — logs are public on a public repo, so names are never written out in full. */
export function mask(username) {
  const u = String(username ?? "");
  return u ? `@${u.slice(0, 2)}…` : "@?";
}

/**
 * @param {object} deps
 * @param {object} deps.api            client from instagram.js
 * @param {object[]} deps.rules        validated rules
 * @param {object} [deps.options]
 * @param {boolean} [deps.options.dryRun]       log what would be sent, send nothing
 * @param {number}  [deps.options.mediaLimit]   how many recent posts to check (default 25)
 * @param {number}  [deps.options.maxActions]   cap on comments looked into per run (default 40)
 * @param {Date}    [deps.options.ignoreBefore] never answer comments older than this (go-live time)
 * @param {boolean} [deps.options.historyCheck] read the DM thread before sending (default true)
 * @param {Date}    [deps.options.now]
 * @param {(line: string) => void} [deps.log]
 */
export async function runOnce({ api, rules, options = {}, log = console.log }) {
  const { dryRun = false, diagnose = false, mediaLimit = 25, maxActions = 40, ignoreBefore = null, historyCheck = true, now = new Date() } = options;
  const summary = {
    checkedMedia: 0, checkedComments: 0, matched: 0, alreadyReplied: 0, alreadyDmed: 0,
    dmSent: 0, replied: 0, fallback: 0, deferred: 0, skippedOld: 0, errors: [],
  };

  const me = await api.me();
  const dmedThisRun = new Set();
  const history = new Map(); // person -> their recent DMs with us, read once per run
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
    if (diagnose) {
      const times = comments.map((c) => Date.parse(c.timestamp));
      const desc = times.every((t, i) => i === 0 || t <= times[i - 1]);
      const asc = times.every((t, i) => i === 0 || t >= times[i - 1]);
      const tally = { user: 0, from: 0, username: 0, none: 0, withReplies: 0 };
      for (const c of comments) {
        if (c.user != null) tally.user++; else if (c.from) tally.from++; else if (c.username) tally.username++; else tally.none++;
        if (c.replies?.data?.length) tally.withReplies++;
      }
      log(`[diagnose] media ${item.id}: ${comments.length} top-level of ${item.comments_count} total, order ${desc ? (asc ? "single/empty" : "newest first") : asc ? "OLDEST FIRST" : "MIXED"}; authors: user=${tally.user} from=${tally.from} username=${tally.username} none=${tally.none}; with replies=${tally.withReplies}`);
      for (const c of comments.filter((x) => x.replies?.data?.length).slice(0, 4)) {
        try {
          const rs = await api.replies(c.id);
          log(`[diagnose]   replies under ${c.id}: ${rs.map((r) => (r.user != null ? `user(${isOurs(r, me) ? "ours" : "not-ours"})` : r.from || r.username ? `from(${isOurs(r, me) ? "ours" : "other"})` : "no-author")).join(",")}`);
        } catch (err) {
          log(`[diagnose]   replies under ${c.id}: failed ${err.message}`);
        }
      }
    }

    for (const c of comments) {
      summary.checkedComments++;
      if (isOurs(c, me)) continue;
      const rule = matchRule(c.text, rules);
      if (!rule) continue;

      const at = new Date(c.timestamp);
      if (now - at > REPLY_WINDOW_MS || (ignoreBefore && at < ignoreBefore)) {
        summary.skippedOld++;
        continue;
      }
      summary.matched++;
      if (dryRun && summary.matched === 1) {
        // Field names only (no values), to confirm what Instagram returns for this account.
        log(`[dry run] comment fields: ${Object.keys(c).join(",")}; from: ${Object.keys(c.from ?? {}).join(",") || "-"}; reply fields: ${Object.keys(c.replies?.data?.[0] ?? {}).join(",") || "-"}`);
      }

      const personId = c.from?.id ?? null;
      const person = personId ?? c.username ?? c.from?.username ?? null;
      const who = mask(c.username ?? c.from?.username);
      const tag = `${rule.name}: comment ${c.id} by ${who}`;

      // Check 1: have we already replied under this comment?
      let replies = c.replies?.data ?? [];
      if (replies.length && replies.some((r) => !hasAuthor(r))) {
        // The nested list came back without authors; ask for this comment's replies directly.
        try {
          replies = await api.replies(c.id);
          if (dryRun && !history.replyShapeLogged) {
            history.replyShapeLogged = true;
            log(`[dry run] reply fields (direct): ${Object.keys(replies[0] ?? {}).join(",") || "-"}; from: ${Object.keys(replies[0]?.from ?? {}).join(",") || "-"}`);
          }
        } catch (err) {
          if (err.kind === "auth") throw err;
          summary.deferred++;
          summary.errors.push(`${tag}: couldn't read its replies (code ${err.code ?? "?"}: ${err.message}); not sending`);
          continue;
        }
      }
      // Instagram returns other people's replies with an author and leaves it off ours,
      // so a reply with no author counts as ours. Either way nothing more is sent.
      if (replies.some((r) => isOurs(r, me) || !hasAuthor(r))) {
        summary.alreadyReplied++;
        if (dryRun) log(`[dry run] ${tag}: already has our reply -> skip`);
        if (diagnose) {
          log(`[diagnose] ${tag}: replies: ${replies.map((r) => `${hasAuthor(r) ? (isOurs(r, me) ? "ours" : "other") : "no-author"} ${JSON.stringify(String(r.text ?? "").replace(/@[\w.]+/g, "@…").slice(0, 30))}`).join(" | ")}`);
          if (personId) {
            try {
              const messages = await api.messagesWith(personId);
              const marker = sentMarker(rule);
              log(`[diagnose] ${tag}: DM thread ${messages.length} msg, ${messages.filter((m) => isOurs(m, me)).length} from us, fields ${Object.keys(messages[0] ?? {}).join(",") || "-"}/${Object.keys(messages[0]?.from ?? {}).join(",") || "-"}, got this DM before: ${messages.some((m) => String(m.message ?? "").includes(marker)) ? "yes" : "no"}`);
            } catch (err) {
              log(`[diagnose] ${tag}: DM history failed (code ${err.code ?? "?"}): ${err.message}`);
            }
          }
        }
        continue;
      }

      if (actions >= maxActions) { summary.deferred++; continue; }
      actions++;

      // Check 2: have we already sent this person this rule's message in DMs?
      if (historyCheck) {
        if (!personId) {
          summary.deferred++;
          summary.errors.push(`${tag}: Instagram didn't return who wrote it, so DM history can't be checked; not sending`);
          continue;
        }
        let messages = history.get(personId);
        if (!messages) {
          try {
            messages = await api.messagesWith(personId);
            history.set(personId, messages);
          } catch (err) {
            if (err.kind === "auth") throw err;
            summary.deferred++;
            summary.errors.push(`${tag}: couldn't read DM history (code ${err.code ?? "?"}: ${err.message}); not sending`);
            continue;
          }
        }
        if (dryRun && messages.length && !history.shapeLogged) {
          history.shapeLogged = true;
          log(`[dry run] message fields: ${Object.keys(messages[0]).join(",")}; from: ${Object.keys(messages[0].from ?? {}).join(",") || "-"}`);
        }
        if (dryRun) log(`[dry run] ${tag}: DM thread has ${messages.length} recent message(s), ${messages.filter((m) => isOurs(m, me)).length} from us`);
        const marker = sentMarker(rule);
        const got = messages.some((m) => String(m.message ?? "").includes(marker) && (isOurs(m, me) || !hasAuthor(m)));
        if (got) {
          summary.alreadyDmed++;
          log(`${dryRun ? "[dry run] " : ""}${tag}: already got this DM -> skip`);
          continue;
        }
      }

      const publicText = pickReply(rule.publicReplies, c.id);
      if (dryRun) {
        log(`[dry run] ${tag} (${String(c.timestamp).slice(0, 16)}): no reply from us, no earlier DM -> would DM and reply "${publicText}"`);
        continue;
      }

      // 1. The DM. One per person per run, even if they commented twice.
      let dmOk = person != null && dmedThisRun.has(person);
      if (!dmOk) {
        try {
          await api.privateReply(c.id, rule.dm);
          dmOk = true;
          if (person != null) dmedThisRun.add(person);
          summary.dmSent++;
        } catch (err) {
          if (err.kind === "auth") throw err;
          if (err.kind === "transient") {
            // Leave the comment unanswered so the next run tries again.
            summary.deferred++;
            summary.errors.push(`${tag}: DM deferred: ${err.message}`);
            continue;
          }
          // Permanent: they can't be DMed. Say so publicly instead.
          summary.errors.push(`${tag}: DM failed (code ${err.code ?? "?"}): ${err.message}`);
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
          if (attempt === 1) summary.errors.push(`${tag}: public reply failed: ${err.message}`);
        }
      }
      if (posted) dmOk ? summary.replied++ : summary.fallback++;
      log(`${tag}: DM ${dmOk ? "sent" : "FAILED"}, public reply ${posted ? `"${text}"` : "FAILED"}`);
    }
  }
  return summary;
}
