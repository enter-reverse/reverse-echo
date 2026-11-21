// The two things the hosted watcher does on its own. Everything else about customer
// chats (drafting replies, the 10 and 20 minute pings, the CX Board) stays with the CX chat.
//
// 1. Auto-replies: a "TRIAL" message, or a claim from the website's WhatsApp button, gets
//    its template at once, but only in a conversation we have never written in.
// 2. The day-1 follow-up: a WhatsApp claimer who has gone quiet gets one approved line
//    before WhatsApp's 24-hour window closes.
//
// There is no database. Chatwoot is the record: labels mark what a conversation is
// ("claim", "trial", "duo") and what has been done ("fu1"), and people can steer it with
// "paid" and "no-followup".

import { INBOX, FOLLOWUP1_MARKER, firstName, followup1, kindOf, tpl } from "./templates.js";

const HOUR = 3600;
const DAY = 24 * HOUR;
const TEAM = new Set([158]); // internal chats
const EMAIL_NOISE = ["noreply", "no-reply", "no_reply", "classpass", "intercom", "loops.so", "facebook", "anthropic", "openai",
  "n8n", "creativeos", "respond.io", "hello@enterreverse", "metamail", "claude.com", "netflix", "chatwoot", "youform", "shopify",
  "apple.com", "spotify", "google.com", "notifications", "mailer", "reallygoodemails", "paddle.com", "newsletter", "news@", "updates@", "info@"];

const sender = (c) => c.meta?.sender ?? {};

/**
 * @param {object} deps.api      client from chatwoot.js
 * @param {object} deps.options
 * @param {boolean} deps.options.dryRun      log what would be sent, send nothing (default true)
 * @param {boolean} deps.options.followups   run the day-1 follow-ups (default false)
 * @param {number}  deps.options.now         unix seconds
 * @param {number}  [deps.options.freshSecs] only auto-reply to messages newer than this (default 15 min)
 */
export async function tick({ api, options = {}, log = console.log }) {
  const { dryRun = true, followups = false, now = Math.floor(Date.now() / 1000), freshSecs = 15 * 60, maxThreads = 15, maxSends = 5 } = options;
  const summary = { checked: 0, autoSent: 0, followupsSent: 0, skipped: 0, errors: [] };
  const tag = dryRun ? "[dry run] " : "";
  let threads = 0;
  let sends = 0;

  // ---- 1. auto-replies -------------------------------------------------------------
  const convs = new Map();
  for (const status of ["open", "pending"]) {
    for (const c of await api.conversations(status)) convs.set(c.id, c);
  }
  for (const [cid, c] of convs) {
    if (TEAM.has(cid) || c.inbox_id === INBOX.waJooChiat) continue; // the store answers its own WhatsApp
    if ((c.last_activity_at ?? 0) <= now - freshSecs) continue;
    if (c.first_reply_created_at) continue; // we've written here before
    if (c.inbox_id === INBOX.email && EMAIL_NOISE.some((n) => (sender(c).email ?? "").toLowerCase().includes(n))) continue;
    if (threads >= maxThreads) { summary.skipped++; continue; }
    threads++;
    try {
      const ms = await api.messages(cid);
      summary.checked++;
      if (ms.some((m) => m.message_type === 1)) continue; // never reply twice
      const hit = ms.find((m) => m.message_type === 0 && m.created_at > now - freshSecs && kindOf(m.content, c.inbox_id));
      if (!hit) continue;
      const kind = kindOf(hit.content, c.inbox_id);
      if (sends >= maxSends) { summary.skipped++; continue; }
      sends++;
      if (dryRun) { log(`${tag}would send the ${kind} reply in conversation ${cid}`); continue; }
      await api.send(cid, tpl(kind, firstName(sender(c).name)));
      summary.autoSent++;
      log(`AUTO-SENT ${kind} reply in conversation ${cid}`);
      await api.addLabels(cid, kind === "trial" ? ["trial"] : kind === "duo" ? ["claim", "duo"] : ["claim"]).catch((e) =>
        summary.errors.push(`labels on ${cid}: ${e.message}`),
      );
    } catch (err) {
      summary.errors.push(`conversation ${cid}: ${err.message}`);
    }
  }

  // ---- 2. day-1 follow-ups ---------------------------------------------------------
  if (followups) {
    let claims = [];
    try { claims = await api.labelled("claim"); } catch (err) { summary.errors.push(`claims list: ${err.message}`); }
    for (const c of claims) {
      const labels = new Set(c.labels ?? []);
      // Only WhatsApp claims at $100 off. Duo ($299 off), Instagram and anything a person has flagged are left to people.
      if (c.inbox_id !== INBOX.waCx || labels.has("duo") || labels.has("paid") || labels.has("no-followup") || labels.has("fu1")) continue;
      if (threads >= maxThreads * 2 || sends >= maxSends) { summary.skipped++; continue; }
      threads++;
      try {
        const ms = await api.messages(c.id);
        const theirs = ms.filter((m) => m.message_type === 0);
        const ours = ms.filter((m) => m.message_type === 1);
        if (!theirs.length || !ours.length) continue; // the first reply hasn't gone out: not a follow-up case
        const claimedAt = theirs[0].created_at;
        const lastTheirs = theirs[theirs.length - 1].created_at;
        if (now < claimedAt + 20 * HOUR) continue; // too early
        if (ms[ms.length - 1].message_type === 0) continue; // they wrote last: that needs an answer, not a nudge
        if (ours.some((m) => m.created_at >= claimedAt + 12 * HOUR || String(m.content ?? "").includes(FOLLOWUP1_MARKER))) {
          if (!dryRun) await api.addLabels(c.id, ["fu1"]).catch(() => {}); // already followed up (by hand or by us)
          continue;
        }
        const closes = lastTheirs + DAY; // WhatsApp only lets us write within 24h of their last message
        if (now > closes - 5 * 60) continue; // window shut
        const due = Math.min(claimedAt + DAY, closes - 4 * HOUR);
        if (now < due) continue;
        sends++;
        if (dryRun) { log(`${tag}would send the day-1 follow-up in conversation ${c.id}`); continue; }
        await api.send(c.id, followup1(firstName(sender(c).name)));
        summary.followupsSent++;
        log(`FOLLOW-UP day 1 sent in conversation ${c.id}`);
        await api.addLabels(c.id, ["fu1"]).catch((e) => summary.errors.push(`labels on ${c.id}: ${e.message}`));
      } catch (err) {
        summary.errors.push(`follow-up ${c.id}: ${err.message}`);
      }
    }
  }
  return summary;
}
