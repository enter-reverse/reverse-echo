// The two things the hosted watcher does on its own. Everything else about customer
// chats (drafting replies, the 10 and 20 minute pings, the CX Board) stays with the CX chat.
//
// 1. Auto-replies: a "TRIAL" message, or a claim from the website's WhatsApp button, gets
//    its template at once, but only in a conversation we have never written in.
// 2. The day-1 follow-up: a WhatsApp claimer who has gone quiet gets one approved line
//    before WhatsApp's 24-hour window closes.
//
// 3. Days 3 and 5: the same quiet claimer gets a Meta-approved template (an invite to see the
//    space, then a last note), each once, in the day after it falls due and only in the daytime.
//
// 4. Alerts to the owner's own WhatsApp chat with the CX line: a customer still unanswered at 10 and
//    again at 20 minutes, and a TRIAL or claim message that got no auto-reply within 5 minutes.
//    Each is sent once, by looking only at the one-minute slice that has just crossed the mark.
//
// There is no database. Chatwoot is the record: labels mark what a conversation is
// ("claim", "trial", "duo") and what has been done ("fu1", "fu3", "fu5"), and people can steer it with
// "paid" and "no-followup".

import { INBOX, FOLLOWUP1_MARKER, TEMPLATES, firstName, followup1, kindOf, tpl } from "./templates.js";

const HOUR = 3600;
const DAY = 24 * HOUR;
const TEAM = new Set([158]); // internal chats
const EMAIL_NOISE = ["noreply", "no-reply", "no_reply", "classpass", "intercom", "loops.so", "facebook", "anthropic", "openai",
  "n8n", "creativeos", "respond.io", "hello@enterreverse", "metamail", "claude.com", "netflix", "chatwoot", "youform", "shopify",
  "apple.com", "spotify", "google.com", "notifications", "mailer", "reallygoodemails", "paddle.com", "newsletter", "news@", "updates@", "info@"];

const sender = (c) => c.meta?.sender ?? {};
/** A message that ends a chat and needs no reply: "Thank you! ☺️", "ok noted", "👍", "Appreciate it". */
export function isCloser(text) {
  if (String(text ?? "").includes("?")) return false;
  const t = String(text ?? "").toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return /\S/.test(String(text ?? "")); // emoji or punctuation only; an attachment (no text) still counts
  return /^((ok(ay)?|kk?|noted|sure|great|cool|nice|alright|got it|perfect|awesome|will do|sounds good|see you|see ya|bye)\s*)*((thanks?|thank you|thx|tq|ty|many thanks|thanks so much|thank you so much|appreciate it|much appreciated|cheers)(\s+(so much|a lot|zoey|again|ya|yah|yes))*)?$/.test(t)
    && t.length <= 40;
}
const CHANNEL = { [INBOX.instagram]: "Instagram", [INBOX.waCx]: "WhatsApp", [INBOX.messenger]: "Messenger", [INBOX.email]: "email", [INBOX.web]: "web chat" };

/**
 * @param {object} deps.api      client from chatwoot.js
 * @param {object} deps.options
 * @param {boolean} deps.options.dryRun      log what would be sent, send nothing (default true)
 * @param {boolean} deps.options.followups   run the day-1 follow-ups (default false)
 * @param {object}  [deps.options.templates] { day3: bool, day5: bool, language } - which template follow-ups to run (default none)
 * @param {object}  [deps.options.alerts]  { conversation, account } - where alerts go (default: no alerts)
 * @param {number}  deps.options.now         unix seconds
 * @param {number}  [deps.options.freshSecs] only auto-reply to messages newer than this (default 15 min)
 * @param {number}  [deps.options.minAgeSecs] and older than this (default 0: answer on the next pass)
 */
export async function tick({ api, options = {}, log = console.log }) {
  const { dryRun = true, followups = false, templates = {}, alerts = null, now = Math.floor(Date.now() / 1000), freshSecs = 15 * 60, minAgeSecs = 0, maxThreads = 15, maxSends = 5 } = options;
  const summary = { checked: 0, autoSent: 0, followupsSent: 0, templatesSent: 0, alertsSent: 0, skipped: 0, errors: [] };
  const tag = dryRun ? "[dry run] " : "";
  let threads = 0;
  let sends = 0;
  // Cloudflare's free plan stops a run at 50 requests. The auto-replies go first; the later passes give way
  // once 38 are spent, and pick up whatever they skipped on their next turn.
  const room = () => (api.used?.() ?? 0) < 38;

  // ---- 1. auto-replies -------------------------------------------------------------
  const read = new Map(); // conversation id -> messages already fetched in this pass
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
      read.set(cid, ms);
      summary.checked++;
      if (ms.some((m) => m.message_type === 1)) continue; // never reply twice
      // This Worker is the only sender of these replies (the CX chat stopped sending them on 22 Nov 2026),
      // so a matching message is answered on the next pass. `minAgeSecs` can add a wait if that ever changes.
      const hit = ms.find((m) => m.message_type === 0 && m.created_at > now - freshSecs && m.created_at <= now - minAgeSecs && kindOf(m.content, c.inbox_id));
      if (!hit) continue;
      const kind = kindOf(hit.content, c.inbox_id);
      if (sends >= maxSends) { summary.skipped++; continue; }
      sends++;
      if (dryRun) { log(`${tag}would send the ${kind} reply in conversation ${cid}`); continue; }
      // Look once more immediately before sending, in case a reply landed while this pass was running.
      if ((await api.messages(cid)).some((m) => m.message_type === 1)) continue;
      await api.send(cid, tpl(kind, firstName(sender(c).name)));
      read.delete(cid); // answered: nothing to alert about
      summary.autoSent++;
      log(`AUTO-SENT ${kind} reply in conversation ${cid}`);
      await api.addLabels(cid, kind === "trial" ? ["trial"] : kind === "red_info" ? ["enquiry"] : kind === "duo" ? ["claim", "duo"] : ["claim"]).catch((e) =>
        summary.errors.push(`labels on ${cid}: ${e.message}`),
      );
    } catch (err) {
      summary.errors.push(`conversation ${cid}: ${err.message}`);
    }
  }

  // ---- 2. day-1 follow-ups ---------------------------------------------------------
  if (followups) {
    const claims = [];
    try {
      // A day-old claim can sit past the first page (the 25 most recently active) on a busy day.
      for (let page = 1; page <= 3; page++) {
        const got = await api.labelled("claim", page);
        claims.push(...got);
        if (got.length < 25) break;
      }
    } catch (err) { summary.errors.push(`claims list: ${err.message}`); }
    for (const c of claims) {
      const labels = new Set(c.labels ?? []);
      // Only WhatsApp claims at $100 off. Duo ($299 off), Instagram and anything a person has flagged are left to people.
      if (c.inbox_id !== INBOX.waCx || labels.has("duo") || labels.has("paid") || labels.has("no-followup") || labels.has("fu1")) continue;
      // Cheap first: only a claim last active 4 to 30 hours ago can be due.
      const quiet = now - (c.last_activity_at ?? now);
      if (quiet < 4 * HOUR || quiet > 30 * HOUR) continue;
      if (threads >= maxThreads * 2 || sends >= maxSends || !room()) { summary.skipped++; continue; }
      threads++;
      try {
        const ms = await api.messages(c.id);
        const theirs = ms.filter((m) => m.message_type === 0);
        const ours = ms.filter((m) => m.message_type === 1);
        if (!theirs.length || !ours.length) continue; // the first reply hasn't gone out: not a follow-up case
        const claimedAt = theirs[0].created_at;
        const lastTheirs = theirs[theirs.length - 1].created_at;
        if (now < claimedAt + 12 * HOUR) continue; // too early
        if (ms[ms.length - 1].message_type === 0) continue; // they wrote last: that needs an answer, not a nudge
        if (ours.some((m) => m.created_at >= claimedAt + 12 * HOUR || String(m.content ?? "").includes(FOLLOWUP1_MARKER))) {
          if (!dryRun) await api.addLabels(c.id, ["fu1"]).catch(() => {}); // already followed up (by hand or by us)
          continue;
        }
        const closes = lastTheirs + DAY; // WhatsApp only lets us write within 24h of their last message
        if (now > closes - 5 * 60) continue; // window shut
        // Never at night: only between 9am and 9pm in Singapore.
        const hour = Math.floor(((now + 8 * HOUR) % DAY) / HOUR);
        if (hour < 9 || hour >= 21) continue;
        const due = Math.min(claimedAt + DAY, closes - 4 * HOUR);
        // Someone who claimed in the small hours falls due at night. If the window would shut before 9am
        // tomorrow, send in the last two hours of this evening instead (still at least 12 hours after the claim).
        const next9am = now - ((now + 8 * HOUR) % DAY) + DAY + 9 * HOUR;
        const lastChance = hour >= 19 && closes - 15 * 60 < next9am && now >= claimedAt + 12 * HOUR;
        if (now < due && !lastChance) continue;
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
  // ---- 3. days 3 and 5 (templates) -------------------------------------------------
  const steps = [["day3", 3], ["day5", 5]].filter(([k]) => templates[k]);
  // Singapore daytime only: nobody wants a marketing message at 3am.
  const sgtHour = Math.floor(((now + 8 * HOUR) % DAY) / HOUR);
  if (steps.length && sgtHour >= 10 && sgtHour < 20) {
    const claims = [];
    try {
      // Claims three to six days old sit past the first page, which holds the 25 most recently active.
      for (let page = 1; page <= 4; page++) {
        const got = await api.labelled("claim", page);
        claims.push(...got);
        if (got.length < 25) break;
      }
    } catch (err) { summary.errors.push(`claims list: ${err.message}`); }
    let read = 0;
    for (const c of claims) {
      const labels = new Set(c.labels ?? []);
      if (c.inbox_id !== INBOX.waCx || labels.has("paid") || labels.has("no-followup")) continue;
      // Quiet for a day (inside 24 hours a person can still write freely) and not older than the last step's day.
      const idle = now - (c.last_activity_at ?? now);
      if (idle < DAY || idle > 6 * DAY) continue;
      const open = steps.filter(([k]) => !labels.has(TEMPLATES[k].label) && !(k === "day5" && labels.has("duo"))); // day 5 names the $100 off, which isn't the Duo offer
      if (!open.length) continue;
      if (read >= 12 || sends >= maxSends || !room()) { summary.skipped++; continue; }
      read++;
      try {
        const ms = await api.messages(c.id);
        const theirs = ms.filter((m) => m.message_type === 0);
        const ours = ms.filter((m) => m.message_type === 1);
        if (!theirs.length || !ours.length) continue;
        if (ms[ms.length - 1].message_type === 0) continue; // they wrote last: that needs an answer, not a nudge
        const claimedAt = theirs[0].created_at;
        const age = now - claimedAt;
        // Each step is sent only in the day after it falls due, so switching this on never reaches back to old claims.
        const step = open.find(([, d]) => age >= d * DAY && age < (d + 1) * DAY);
        if (!step) continue;
        const t = TEMPLATES[step[0]];
        // One template a day at most, and never on top of something we sent in the last 20 hours.
        if (now - ours[ours.length - 1].created_at < 20 * HOUR) continue;
        const name = firstName(sender(c).name);
        if (!name) { log(`no usable first name in conversation ${c.id}: ${step[0]} template left to a person`); continue; }
        sends++;
        if (dryRun) { log(`${tag}would send the ${step[0]} template in conversation ${c.id}`); continue; }
        await api.sendTemplate(c.id, { name: t.name, language: templates.language || "en", body: { 1: name }, content: t.text(name) });
        summary.templatesSent++;
        log(`FOLLOW-UP ${step[0]} template sent in conversation ${c.id}`);
        await api.addLabels(c.id, [t.label]).catch((e) => summary.errors.push(`labels on ${c.id}: ${e.message}`));
      } catch (err) {
        summary.errors.push(`template follow-up ${c.id}: ${err.message}`);
      }
    }
  }
  // ---- 4. alerts -------------------------------------------------------------------
  const alertTo = alerts ? (alerts.conversations ?? [alerts.conversation]).filter(Boolean) : [];
  if (alertTo.length) {
    const MIN = 60;
    // `now` is the minute Cloudflare scheduled this pass for, so consecutive passes look at back-to-back
    // one-minute slices and each waiting message crosses each mark in exactly one of them.
    const crossed = (m, mins) => m.created_at > now - (mins + 1) * MIN && m.created_at <= now - mins * MIN;
    let looked = 0;
    for (const [cid, c] of convs) {
      if (TEAM.has(cid) || alertTo.includes(cid) || c.inbox_id === INBOX.waJooChiat) continue;
      if ((c.last_activity_at ?? 0) <= now - 22 * MIN) continue; // nothing here can be crossing a mark
      if (c.inbox_id === INBOX.email && EMAIL_NOISE.some((n) => (sender(c).email ?? "").toLowerCase().includes(n))) continue;
      try {
        let ms = read.get(cid);
        if (!ms) {
          if (looked >= 8 || !room()) { summary.skipped++; continue; }
          looked++;
          ms = await api.messages(cid);
        }
        // The oldest customer message with no reply from us after it. A sign-off ("thanks", "ok", "👍") needs
        // no reply, so it never starts the clock (the user, 22 Nov: no pings for chats that have ended).
        let waiting = null;
        for (const m of ms) {
          if (m.message_type === 0) waiting = waiting ?? (isCloser(m.content) ? null : m);
          else if (waiting && m.created_at > waiting.created_at) waiting = null;
        }
        if (!waiting) continue;
        const kind = !ms.some((m) => m.message_type === 1) && kindOf(waiting.content, c.inbox_id);
        const what = kind && crossed(waiting, 5) ? `No auto-reply after 5 min (${kind})`
          : crossed(waiting, 20) ? "Unanswered 20 min" : null; // no 10-minute ping (the user, 22 Nov: the CX chat answers within minutes)
        if (!what) continue;
        log(`ALERT ${what} in conversation ${cid}`);
        if (dryRun) continue;
        const said = String(waiting.content ?? "").trim().replace(/\s+/g, " ").slice(0, 300) || "[attachment]";
        const at = new Date((waiting.created_at + 8 * HOUR) * 1000).toISOString().slice(11, 16);
        const link = alerts.account ? `\n\nhttps://app.chatwoot.com/app/accounts/${alerts.account}/conversations/${cid}` : "";
        const text = `${what}\n\n${sender(c).name || "Someone"} on ${CHANNEL[c.inbox_id] ?? "chat"}, since ${at}\n\n"${said}"${link}`;
        let sent = false;
        for (const to of alertTo) {
          try {
            await api.send(to, text);
            sent = true;
          } catch (err) {
            // Most likely that person's 24-hour WhatsApp window has closed; the others still get it.
            summary.errors.push(`ALERT NOT DELIVERED for conversation ${cid} to ${to}: ${err.message}`);
          }
        }
        if (sent) summary.alertsSent++;
      } catch (err) {
        summary.errors.push(`alert check ${cid}: ${err.message}`);
      }
    }
  }
  return summary;
}