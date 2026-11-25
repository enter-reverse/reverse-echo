// The staff Telegram bot (ReverseZoeyBot), answered in seconds.
//
// Chatwoot sends every new message in the Telegram inbox to POST /tg-bot (an "agent bot" on that inbox).
// The webhook body is only a nudge: we never trust what it says. We fetch the conversation from Chatwoot
// with our own token, answer its latest staff message if nobody has answered it yet, and post the reply.
//
// Knowledge: the condensed CX playbook plus the published Reverse Academy pages, read through one
// Supabase function (public.zoey_bot_context) that needs ZOEY_BOT_KEY. The answer is written by Claude
// (ANTHROPIC_API_KEY). Bookings and anything needing a person's approval are handed to Elijah's Claude
// session, which keeps checking this inbox every minute; for those we reply with a standby line only.
//
// Off until both ANTHROPIC_API_KEY and ZOEY_BOT_KEY are set (Elijah, 25 Nov 2026).

export const TG_INBOX = 160059;
// Starts every holding reply; Elijah's Claude session treats a message starting with this as "not answered yet".
export const STANDBY = "Got it! Give me a minute";
export const NOT_COVERED = "This isn't covered yet, please check with the full-timers.";
const MODEL = "claude-sonnet-5-5";

const SYSTEM = `You are Zoey, the helper bot for the staff of Reverse, a private recovery studio in Singapore (HBOT, Contrast, Red Light, Dry Float). You are chatting on Telegram with a staff member (usually a part-timer), never with a customer.

Answer only from the CONTEXT: the CX facts and the Academy pages. Never guess or add facts that aren't there.
- If the context doesn't answer the question, reply exactly: "${NOT_COVERED}"
- If it answers part of it, answer that part and add "${NOT_COVERED}" for the rest.
- Health or medical questions about a client (conditions, medication, pregnancy, "can someone with X do Y"): don't answer from general knowledge; reply "${NOT_COVERED}" unless an Academy page covers that exact case.
- Safety and emergency questions: give the Academy steps exactly; if the exact situation isn't covered, give the general emergency steps and say the specific case isn't covered.
- When you use an Academy page, end with one line: (from: <page title>). If you used the CX facts, write (from: CX playbook).
- If they ask you to book, cancel or reschedule a client, or ask about free slots or availability, reply with exactly the word HANDOFF and nothing else.
- If they ask you to draft a message to a customer, write it in the customer-facing rules from the CX facts.
- Style: short, plain, friendly, like a helpful colleague on Telegram. Lists only for steps. No sign-off, no "Any other questions" line, no filler openers.`;

/** Is this webhook worth looking at? Only a new incoming message in the Telegram inbox. */
export function wanted(body) {
  if (!body || body.event !== "message_created") return false;
  const inbox = body.inbox?.id ?? body.conversation?.inbox_id;
  const type = body.message_type;
  return Number(inbox) === TG_INBOX && (type === "incoming" || type === 0) && !body.private && Number(body.conversation?.id) > 0;
}

/** Group chats have a negative Telegram chat id; the bot is private-only (Elijah, 25 Nov). */
const isGroup = (conv) => Number(conv?.additional_attributes?.chat_id) < 0;

/** The staff messages since our last real answer (a standby line is not an answer), or [] if none. */
export function pending(messages) {
  let lastAnswer = 0;
  for (const m of messages) {
    if (m.message_type === 1 && !String(m.content ?? "").startsWith(STANDBY)) lastAnswer = Math.max(lastAnswer, m.created_at);
  }
  return messages.filter((m) => m.message_type === 0 && m.created_at > lastAnswer && String(m.content ?? "").trim());
}

async function context(env, q, fetchImpl) {
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/zoey_bot_context`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_key: env.ZOEY_BOT_KEY, p_q: q }),
  });
  if (!res.ok) throw new Error(`Supabase context -> HTTP ${res.status}`);
  return res.json();
}

async function claude(env, system, user, fetchImpl) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.TG_BOT_MODEL || MODEL, max_tokens: 900, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude -> HTTP ${res.status}`);
  const j = await res.json();
  return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

/** Answer one conversation. Returns what happened, for the log. */
export async function answer({ api, env, cid, fetchImpl = fetch, log = console.log, dryRun = false }) {
  if (!env.ANTHROPIC_API_KEY || !env.ZOEY_BOT_KEY) return { cid, skipped: "not configured" };
  const conv = await api.conversation(cid);
  if (Number(conv?.inbox_id) !== TG_INBOX) return { cid, skipped: "not the Telegram inbox" };
  if (isGroup(conv)) return { cid, skipped: "group chat" };
  const ms = await api.messages(cid);
  const ask = pending(ms);
  if (!ask.length) return { cid, skipped: "already answered" };
  const question = ask.map((m) => m.content.trim()).filter((t) => t !== "/start").join("\n");
  if (!question) {
    const hello = "Hi! I'm Zoey, Reverse's helper. Ask me about SOPs, room resets, running sessions, prices and passes, free slots, or what to reply to a customer.";
    if (!dryRun) await api.send(cid, hello);
    return { cid, sent: "hello" };
  }
  const recent = ms.slice(-10).map((m) => `${m.message_type === 0 ? "Staff" : "Zoey"}: ${String(m.content ?? "").slice(0, 600)}`).join("\n");
  const ctx = await context(env, question, fetchImpl);
  const pages = (ctx.chunks ?? []).map((c) => `[${c.title}${c.heading ? " / " + c.heading : ""}]\n${c.text}`).join("\n\n");
  const user = `CONTEXT\n\n=== CX facts ===\n${ctx.playbook ?? "(none)"}\n\n=== Academy pages (published) ===\n${pages || "(no matching pages)"}\n\nCONVERSATION SO FAR\n${recent}\n\nNEW MESSAGE FROM STAFF\n${question}`;
  let reply = await claude(env, SYSTEM, user, fetchImpl);
  if (!reply) reply = NOT_COVERED;
  if (/^HANDOFF\b/i.test(reply)) {
    // Bookings need a person's yes in Elijah's Claude chat; that session picks this up within a minute.
    if (!dryRun) await api.send(cid, `${STANDBY}, I'm checking that for you 🙏`);
    log(JSON.stringify({ tgBot: { cid, handoff: true } }));
    return { cid, handoff: true };
  }
  if (!dryRun) await api.send(cid, reply.slice(0, 3800));
  if (reply.includes(NOT_COVERED) && !dryRun) {
    // A private note, so the gap is easy to find later and the Academy can be filled in.
    await api.note(cid, `Academy gap: "${question.slice(0, 300)}"`).catch(() => {});
  }
  log(JSON.stringify({ tgBot: { cid, sent: reply.length, gap: reply.includes(NOT_COVERED) } }));
  return { cid, sent: reply.length };
}
