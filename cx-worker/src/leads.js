// Meta lead form leads (the Redlight lead form ad, H12, from 22 Nov 2026). Every 5 minutes, in its own run,
// each lead goes into Loops (the user, 22 Nov: "when we collect this email and phone ... make sure that it goes into loops as well").
// Loops is keyed by email, so seeing the same lead twice only rewrites the same contact. No email is sent from here.
// No WhatsApp is sent from here: lead-form leads are followed up on Instagram (the form's chat follow-up),
// not WhatsApp (the user, 23 Nov 2026: "we're commiting to ig instead").

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

export async function syncLeads({ env, now, fetchImpl = fetch, log = console.log, dryRun = false }) {
  const forms = parseForms(env.LEAD_FORMS);
  const summary = { leads: 0, created: 0, updated: 0, skipped: 0, errors: [] };
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
  return summary;
}
