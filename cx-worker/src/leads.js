// Meta lead form leads into Loops (the user, 22 Nov 2026: "when we collect this email and phone ... make sure that it
// goes into loops as well"). Every 10 minutes the watcher reads the last 2 hours of leads from each form in LEAD_FORMS
// and creates or updates each person in Loops. Loops is keyed by email, so running over the same lead again only
// rewrites the same contact: there is no database and nothing to remember. No email is sent from here; a contact
// only lands in Loops with its source, ready for whatever flow is chosen later.

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
  if (!forms.length || !env.META_PAGE_TOKEN || !env.LOOPS_API_KEY) return summary;
  const since = now - 2 * 3600;
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
    for (const lead of leads) {
      summary.leads++;
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
