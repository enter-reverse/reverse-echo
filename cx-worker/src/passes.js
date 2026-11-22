// The pass counter (the user, 22 Nov 2026): each time a pass sells, WhatsApp the user from Zoey's number
// with the new total and what we can trace of that buyer's journey. It runs off Shopify's "order paid"
// notification, so there is nothing to poll and no AI turn involved.
//
// What counts: the monthly pass (Shopify sku 100116): All-Access +1, Duo (quantity 2) +2, and Red Light monthly
// ("8 RLT/mth", the same recurring pass under another name: the user, 22 Nov 2026) +1. Team tests ($0/$1 orders,
// "TEST" titles, @enterreverse.com emails) add nothing. Monthly renewals of an existing pass add nothing either.
//
// No database: the running total is read back from the last "Total: N" this Worker (or the CX chat) sent
// the user, falling back to PASS_BASE_TOTAL (61, confirmed by the user on 22 Nov 2026 01:38 SGT; it was 2 short:
// both Red Light passes, #2613 and #2619, count, so the right total after #2635 is 65).
// Studio sales rung up in Mindbody never reach Shopify, so they are not seen here; the CX chat adds those.

import { buyerKeys } from "./shopify.js";

const PASS_SKU = "100116";
const DAY = 24 * 3600;
const SGT = 8 * 3600;

/** What one paid Shopify order adds to the count: { kind, n }, n = 0 when it shouldn't count. */
export function passDelta(order) {
  const line = (order?.line_items ?? []).find((li) => String(li.sku ?? "").startsWith(PASS_SKU));
  if (!line) return { kind: null, n: 0 };
  const title = String(line.title ?? "");
  const email = String(order.email ?? order.customer?.email ?? "").toLowerCase();
  const test = Number(order.total_price ?? 0) <= 1 || /test/i.test(title) || email.endsWith("@enterreverse.com")
    || order.cancelled_at || (order.financial_status && order.financial_status !== "paid");
  if (test) return { kind: "test", n: 0 };
  // A member's monthly renewal arrives as a new paid order with the same sku. Shopify's subscription app tags
  // the first one "Subscription First Order"; any other subscription order is a renewal, not a new pass.
  const tags = String(order.tags ?? "");
  if (/subscription/i.test(tags) && !/first order/i.test(tags)) return { kind: "renewal", n: 0 };
  if (Number(line.quantity ?? 1) >= 2) return { kind: "Duo", n: 2 };
  if (/RLT/i.test(title)) return { kind: "Red Light", n: 1 };
  return { kind: "All-Access", n: 1 };
}

const sgt = (unix) => {
  const d = new Date((unix + SGT) * 1000);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const span = (secs) => (secs < 3600 ? `${Math.max(1, Math.round(secs / 60))} min` : secs < 2 * DAY ? `${Math.round(secs / 3600)} h` : `${Math.round(secs / DAY)} days`);
const firstWord = (s) => String(s ?? "").trim().split(/\s+/)[0] || "";

/** Where the order says they came from (landing page, ad, email), or null when Shopify didn't record it. */
export function cameFrom(order) {
  const landing = String(order?.landing_site ?? "");
  const ref = String(order?.referring_site ?? "");
  const q = new URLSearchParams(landing.includes("?") ? landing.slice(landing.indexOf("?") + 1) : "");
  if (q.get("utm_medium") === "email") return `an email link (${[q.get("utm_campaign"), q.get("utm_content")].filter(Boolean).join(", ")})`;
  const page = ref ? ref.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  if (q.get("fbclid")) return `a Facebook/Instagram ad${page ? ` via ${page}` : ""} (ad name not in the order)`;
  if (q.get("utm_source")) return `${q.get("utm_source")}${q.get("utm_content") ? ` (${q.get("utm_content")})` : ""}${page ? ` via ${page}` : ""}`;
  if (page) return page;
  if (order?.source_name === "pos") return "the studio (paid in person)";
  return null;
}

/** The buyer's chats in Chatwoot, by exact phone or email (as markPaid matches them). */
async function buyerChats(api, order) {
  const { phones, emails } = buyerKeys(order);
  const convs = new Map();
  for (const key of [...phones, ...emails].slice(0, 4)) {
    const isPhone = !key.includes("@");
    for (const c of (await api.searchContacts(key)).slice(0, 5)) {
      const exact = isPhone ? String(c.phone_number ?? "").replace(/\D/g, "").endsWith(key) : String(c.email ?? "").toLowerCase() === key;
      if (!exact) continue;
      for (const conv of (await api.contactConversations(c.id)).slice(0, 10)) convs.set(conv.id, conv);
    }
  }
  return [...convs.values()];
}

/** Four or five short blocks on how this buyer got here; says plainly what couldn't be traced. */
export async function journey({ api, order, now }) {
  const paidAt = order?.created_at ? Math.floor(Date.parse(order.created_at) / 1000) : now;
  const lines = [];
  const from = cameFrom(order);

  let chats = [];
  try { chats = await buyerChats(api, order); } catch { /* Chatwoot unreachable: say so below */ }
  const threads = [];
  for (const c of chats.slice(0, 3)) {
    try { threads.push({ c, ms: await api.messages(c.id) }); } catch { /* skip this one */ }
  }
  const all = threads.flatMap((t) => t.ms);
  const theirs = all.filter((m) => m.message_type === 0).sort((a, b) => a.created_at - b.created_at);
  const ours = all.filter((m) => m.message_type === 1);
  const claim = theirs.find((m) => /claim my \$\d+ off/i.test(m.content ?? ""));
  const trial = theirs.find((m) => /^\W*trial\W*$/i.test(m.content ?? ""));

  if (claim) {
    const what = (claim.content.match(/off ([A-Za-z ]+?),/) ?? [])[1] ?? "the offer";
    lines.push(`Claimed $100 off ${what} on WhatsApp, ${sgt(claim.created_at)}`);
  } else if (trial) {
    lines.push(`Asked for the trial ("TRIAL"), ${sgt(trial.created_at)}`);
  } else {
    lines.push("No claim on WhatsApp or Instagram that I can match to them");
  }
  lines.push(`Came to checkout from ${from ?? "a page Shopify didn't record"}`);

  if (theirs.length) {
    const asked = theirs.filter((m) => m !== claim && m !== trial && String(m.content ?? "").trim().length > 3);
    const q = asked.length ? `asked: "${String(asked[0].content).replace(/\s+/g, " ").slice(0, 70)}"${asked.length > 1 ? ` (+${asked.length - 1} more)` : ""}` : "no questions";
    lines.push(`Chat: ${theirs.length} message${theirs.length > 1 ? "s" : ""} from them, ${ours.length} from us; ${q}`);
    const fu = ours.filter((m) => /still saved for you|last note from me|come and see the space/i.test(m.content ?? "")).length;
    lines.push(`Follow-ups from us: ${fu}. Emails: not traced here (they're in Loops)`);
    lines.push(`First contact to paid: ${span(Math.max(0, paidAt - theirs[0].created_at))}`);
  } else {
    lines.push(`Chat: none ${chats.length ? "with messages" : "matched by their phone or email"}. Emails: not traced here (they're in Loops)`);
    lines.push("First contact to paid: not traceable (the order is the first trace)");
  }
  return lines.slice(0, 5);
}

/** The total the user was last told, from the "Total: N" lines in their chat with Zoey's number. */
export function lastTotal(messages, base) {
  for (const m of [...messages].reverse()) {
    if (m.message_type !== 1) continue;
    const hit = String(m.content ?? "").match(/Total: (\d+)/);
    if (hit) return Number(hit[1]);
  }
  return base;
}

/** Runs on each paid Shopify order. Sends at most one message; never twice for the same order. */
export async function countPass({ api, order, env, dryRun = false, now = Math.floor(Date.now() / 1000), log = console.log }) {
  const conv = Number(env.PASS_ALERT_CONV || 0);
  const { kind, n } = passDelta(order);
  if (!conv || !n) { if (kind) log(`pass counter: order ${order?.name} is ${kind}, not counted`); return { counted: 0 }; }

  const ms = await api.allMessages(conv); // notes too: a total recorded while the window was closed still counts
  const tag = `Order ${order.name}`;
  if (ms.some((m) => m.message_type === 1 && String(m.content ?? "").includes(tag))) { log(`pass counter: ${tag} already sent`); return { counted: 0 }; }
  const total = lastTotal(ms, Number(env.PASS_BASE_TOTAL || 0)) + n;
  const name = firstWord(order.customer?.first_name) || firstWord(order.billing_address?.first_name) || "someone";
  const text = [`🎉 New pass: ${name}, ${kind}`, `Total: ${total}`, "", ...(await journey({ api, order, now })).flatMap((l) => [l, ""]), tag].join("\n").trim();

  // WhatsApp lets us write only within 24 hours of the user's own last message to this number.
  const lastFromUser = Math.max(0, ...ms.filter((m) => m.message_type === 0 && !m.private).map((m) => m.created_at));
  if (now - lastFromUser > DAY - 300) {
    log(`pass counter: ${tag} not sent, the user's 24-hour window is closed (total now ${total})`);
    if (!dryRun) await api.note(conv, `Not sent (WhatsApp window closed):\n\n${text}`).catch(() => {});
    return { counted: n, sent: false, total };
  }
  if (dryRun) { log(`[dry run] pass counter would send:\n${text}`); return { counted: n, sent: false, total }; }
  await api.send(conv, text);
  log(`pass counter: ${tag} sent, total ${total}`);
  return { counted: n, sent: true, total };
}
