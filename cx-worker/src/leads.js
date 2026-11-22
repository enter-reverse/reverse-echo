// Meta lead form leads (the Redlight lead form ad, H12, from 22 Nov 2026). Every 5 minutes, in its own run:
// 1. Into Loops (the user, 22 Nov: "when we collect this email and phone ... make sure that it goes into loops as well"):
//    each lead under 20 minutes old is created or updated in Loops. Loops is keyed by email, so seeing the same lead
//    twice only rewrites the same contact. No email is sent from here.
// 2. A WhatsApp from Zoey's CX number (the user, 23 Nov: "we definitely need to set up an automation to hit these
//    signups asap"): a lead with a phone number gets the Meta-approved template LEAD_TEMPLATE in a Chatwoot
//    conversation labelled "lead-form", between 9am and 9pm Singapore time. A lead from the night is sent at 9am
//    (leads are read back 30 hours). The label is the memory: anyone already in a "lead-form" chat is never sent
//    twice. Their reply lands in Chatwoot like any chat, and the unanswered alerts bring a person in.

import { firstName } from "./templates.js";

const GRAPH = "https://graph.facebook.com/v25.0";
const LOOPS = "https://app.loops.so/api/v1";

/** A lead's answers as { first_name, full_name, email, phone_number, ... } (first value of each field). */
export function answers(lead) {
  const out = {};
  for (const f of lead?.field_data ?? []) out[String(f.name ?? "").toLowerCase()] = String((f.values ?? [])[0] ?? "").trim();
  return out;
}

/** The Loops contact for a lead, or null when it has no usable email. */
export function contactFor(lead, formName) {
  const a = answers(lead);
  const email = (a.email ?? "").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  const first = a.first_name || (a.full_name ?? "").split(/\s+/)[0] || "";
  const phone = (a.phone_number ?? a.phone ?? "").replace(/[^\d+]/g, "");
  return {
    email,
    ...(first ? { firstName: first } : {}),
    ...(phone ? { phone } : {}),
    source: `${formName || "Meta lead form"}${lead?.ad_name ? ` (${lead.ad_name})` : ""}`,
  };
}

/** "980030121464233:Redlight lead form (H12), 123:Other" -> [{ id, name }]. A bare id gets a generic name. */
export function parseForms(v) {
  return String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [id, ...rest] = x.split(":");
    return { id: id.trim(), name: rest.join(":").trim() };
  }).filter((f) => /^\d+$/.test(f.id));
}

/** A phone number as WhatsApp wants it ("+6591234567"), or "" when it doesn't look like one. Bare 8-digit SG numbers get +65. */
export function waPhone(raw) {
  let d = String(raw ?? "").replace(/[^\d+]/g, "");
  if (/^[689]\d{7}$/.test(d)) d = "+65" + d;
  else if (/^65[689]\d{7}$/.test(d)) d = "+" + d;
  else if (/^\d{10,15}$/.test(d)) d = "+" + d;
  return /^\+\d{8,15}$/.test(d) ? d : "";
}

const digits = (x) => String(x ?? "").replace(/\D/g, "");

/** The WhatsApp template the lead is sent; LEAD_TEMPLATE_TEXT is only what Chatwoot shows ({{1}} = first name). */
export function leadTemplate(env, name) {
  const text = String(env.LEAD_TEMPLATE_TEXT || "Hi {{1}}! Thanks for checking out Redlight at Reverse.").replace(/\\n/g, "\n");
  return { name: env.LEAD_TEMPLATE, language: env.TEMPLATE_LANGUAGE || "en", body: { 1: name }, content: text.replaceAll("{{1}}", name) };
}

export async function syncLeads({ env, now, fetchImpl = fetch, log = console.log, dryRun = false, api = null }) {
  const forms = parseForms(env.LEAD_FORMS);
  const summary = { leads: 0, created: 0, updated: 0, skipped: 0, whatsapped: 0, errors: [] };
  if (!forms.length || !env.META_PAGE_TOKEN) return summary;
  const since = now - 30 * 3600;
  const all = [];
  for (const form of forms) {
    let leads = [];
    try {
      const filter = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]));
      const r = await fetchImpl(`${GRAPH}/${form.id}/leads?fields=id,created_time,ad_name,field_data&limit=100&filtering=${filter}&access_token=${encodeURIComponent(env.META_PAGE_TOKEN)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
      leads = body.data ?? [];
    } catch (e) {
      summary.errors.push(`leads for form ${form.id}: ${e.message}`);
      continue;
    }
    for (const lead of leads) all.push({ lead, form });
  }
  summary.leads = all.length;
  // Loops: the last 20 minutes on every run, and the whole 30 hours on the first run of each hour (so nothing missed
  // while it was down, or before it went live, is left out). At most 12 a run, to stay inside the run's request limit.
  const sweep = Math.floor((now % 3600) / 60) < 5;
  const forLoops = all.filter(({ lead }) => sweep || now - Math.floor(Date.parse(lead.created_time ?? 0) / 1000) <= 20 * 60).slice(0, 12);
  if (env.LOOPS_API_KEY) {
    for (const { lead, form } of forLoops) {
      const contact = contactFor(lead, form.name);
      if (!contact) { summary.skipped++; continue; }
      if (dryRun) { log(`[dry run] would add lead ${lead.id} to Loops`); continue; }
      const headers = { Authorization: `Bearer ${env.LOOPS_API_KEY}`, "Content-Type": "application/json" };
      try {
        // Create first, so a new contact carries the form as its source; someone already in Loops keeps theirs
        // and just gets the phone and name filled in.
        const c = await fetchImpl(`${LOOPS}/contacts/create`, { method: "POST", headers, body: JSON.stringify(contact) });
        if (c.ok) { summary.created++; log(`LEAD to Loops (new contact) from form ${form.id}`); continue; }
        if (c.status !== 409) throw new Error(`create: HTTP ${c.status}`);
        const { source, ...rest } = contact;
        const u = await fetchImpl(`${LOOPS}/contacts/update`, { method: "PUT", headers, body: JSON.stringify(rest) });
        if (!u.ok) throw new Error(`update: HTTP ${u.status}`);
        summary.updated++;
      } catch (e) {
        summary.errors.push(`lead ${lead.id}: ${e.message}`);
      }
    }
  }
  if (api && env.LEAD_TEMPLATE) await whatsappLeads({ api, env, now, leads: all, summary, log, dryRun });
  return summary;
}

const LEAD_LABEL = "lead-form";
const HOUR = 3600;

/** Sends each lead not yet in a "lead-form" chat the welcome template (at most 4 a run, daytime only). */
export async function whatsappLeads({ api, env, now, leads, summary, log = console.log, dryRun = false, inbox = Number(env.LEAD_INBOX || 156990) }) {
  const hour = Math.floor(((now + 8 * HOUR) % (24 * HOUR)) / HOUR);
  if (hour < 9 || hour >= 21) return;
  const todo = leads.map(({ lead, form }) => ({ lead, form, a: answers(lead) }))
    .map((x) => ({ ...x, phone: waPhone(x.a.phone_number ?? x.a.phone) })).filter((x) => x.phone);
  if (!todo.length) return;
  // Who has been sent already: the phone numbers on every "lead-form" chat.
  const done = new Set();
  try {
    for (let page = 1; page <= 4; page++) {
      const got = await api.labelled(LEAD_LABEL, page);
      for (const c of got) done.add(digits(c.meta?.sender?.phone_number));
      if (got.length < 25) break;
    }
  } catch (e) { summary.errors.push(`lead-form chats: ${e.message}`); return; } // can't tell who's been sent: send nobody
  let sent = 0;
  for (const { lead, form, a, phone } of todo) {
    if (done.has(digits(phone))) continue;
    if (sent >= 4) { summary.skipped++; continue; }
    sent++;
    done.add(digits(phone)); // two leads with one number: one message
    const name = firstName(a.first_name || a.full_name) || "there";
    if (dryRun) { log(`[dry run] would WhatsApp lead ${lead.id}`); continue; }
    try {
      // Their contact in Chatwoot (found by number, else made), then a conversation in the CX inbox.
      let contact = (await api.searchContacts(phone)).find((c) => digits(c.phone_number) === digits(phone));
      if (!contact) contact = await api.createContact({ inbox_id: inbox, name: a.full_name || a.first_name || phone, phone_number: phone, ...(a.email ? { email: a.email.toLowerCase() } : {}) });
      let conv = (await api.contactConversations(contact.id)).find((c) => c.inbox_id === inbox);
      if (!conv) {
        const ci = (contact.contact_inboxes ?? []).find((x) => (x.inbox?.id ?? x.inbox_id) === inbox);
        conv = await api.createConversation({ inbox_id: inbox, contact_id: contact.id, ...(ci?.source_id ? { source_id: ci.source_id } : {}) });
      }
      await api.sendTemplate(conv.id, leadTemplate(env, name));
      summary.whatsapped++;
      log(`LEAD WhatsApped in conversation ${conv.id} (form ${form.id})`);
      await api.addLabels(conv.id, [LEAD_LABEL, "no-followup"]).catch((e) => summary.errors.push(`labels on ${conv.id}: ${e.message}`));
      await api.note(conv.id, `From the ${form.name || "Meta lead form"}${lead.ad_name ? ` (${lead.ad_name})` : ""}. They filled in the form and got the welcome WhatsApp automatically; they haven't messaged us yet.`).catch(() => {});
    } catch (e) {
      summary.errors.push(`WhatsApp lead ${lead.id}: ${e.message}`);
    }
  }
}
