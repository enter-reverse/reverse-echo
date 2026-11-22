import { test } from "node:test";
import assert from "node:assert/strict";
import { answers, contactFor, parseForms, syncLeads } from "../src/leads.js";

const lead = (id, fields, ad = "ad-redlight-leadform") => ({ id, ad_name: ad, field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })) });

test("a lead's answers become a Loops contact with the form as its source", () => {
  const l = lead("1", { first_name: "Mei", email: " Mei@Example.com ", phone_number: "+65 9123 4567" });
  assert.deepEqual(answers(l).first_name, "Mei");
  assert.deepEqual(contactFor(l, "Redlight lead form (H12)"), { email: "mei@example.com", firstName: "Mei", phone: "+6591234567", source: "Redlight lead form (H12) (ad-redlight-leadform)" });
  assert.equal(contactFor(lead("2", { full_name: "Tan Ah Kow", email: "a@b.co" }), "").firstName, "Tan");
  assert.equal(contactFor(lead("3", { first_name: "No", phone_number: "91234567" }), "x"), null, "no email: skipped");
});

test("LEAD_FORMS reads ids with optional names", () => {
  assert.deepEqual(parseForms("980030121464233:Redlight lead form (H12), 12:Other, junk"), [{ id: "980030121464233", name: "Redlight lead form (H12)" }, { id: "12", name: "Other" }]);
});

test("new people are created in Loops, existing ones updated without touching their source; off without the keys", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (url.includes("graph.facebook.com")) return { ok: true, json: async () => ({ data: [lead("1", { first_name: "Mei", email: "mei@x.com" }), lead("2", { first_name: "Old", email: "old@x.com" }), lead("3", { first_name: "Nomail" })] }) };
    if (url.endsWith("/contacts/create")) return { ok: !calls.at(-1).body.email.startsWith("old"), status: calls.at(-1).body.email.startsWith("old") ? 409 : 200 };
    if (url.endsWith("/contacts/update")) return { ok: true, status: 200 };
  };
  const env = { LEAD_FORMS: "980030121464233:Redlight lead form (H12)", META_PAGE_TOKEN: "t", LOOPS_API_KEY: "k" };
  const s = await syncLeads({ env, now: 1_800_000_000, fetchImpl, log: () => {} });
  assert.deepEqual({ leads: s.leads, created: s.created, updated: s.updated, skipped: s.skipped }, { leads: 3, created: 1, updated: 1, skipped: 1 });
  const upd = calls.find((c) => c.url.endsWith("/contacts/update"));
  assert.equal(upd.body.source, undefined, "an existing contact keeps its source");
  assert.match(calls[0].url, /980030121464233\/leads/);
  const off = await syncLeads({ env: { LEAD_FORMS: env.LEAD_FORMS }, now: 1, fetchImpl: () => { throw new Error("called"); } });
  assert.equal(off.leads, 0);
});

import { waPhone, whatsappLeads, leadTemplate } from "../src/leads.js";

test("phone numbers come out as WhatsApp wants them", () => {
  assert.equal(waPhone("9123 4567"), "+6591234567");
  assert.equal(waPhone("+65 9123 4567"), "+6591234567");
  assert.equal(waPhone("6591234567"), "+6591234567");
  assert.equal(waPhone("12"), "");
});

// 1_800_000_000 is 4pm in Singapore; 8 hours later is midnight.
const DAY_AM = 1_800_000_000;
function fakeApi({ sentPhones = [], existing = null } = {}) {
  const calls = [];
  return {
    calls,
    labelled: async () => sentPhones.map((p, i) => ({ id: 900 + i, meta: { sender: { phone_number: p } } })),
    searchContacts: async () => (existing ? [existing] : []),
    createContact: async (b) => { calls.push(["contact", b]); return { id: 7, phone_number: b.phone_number, contact_inboxes: [{ inbox: { id: 156990 }, source_id: "src" }] }; },
    contactConversations: async () => [],
    createConversation: async (b) => { calls.push(["conversation", b]); return { id: 500 }; },
    sendTemplate: async (cid, t) => { calls.push(["template", cid, t]); },
    addLabels: async (cid, l) => { calls.push(["labels", cid, l]); },
    note: async () => {},
  };
}
const env = { LEAD_TEMPLATE: "redlight_lead_welcome", LEAD_TEMPLATE_TEXT: "Hi {{1}}! Thanks.\\n\\n- Zoey" };
const L = (id, f) => ({ lead: lead(id, f), form: { id: "980030121464233", name: "Redlight lead form (H12)" } });

test("a new lead gets the welcome template once, in a labelled chat", async () => {
  const api = fakeApi();
  const summary = { whatsapped: 0, skipped: 0, errors: [] };
  await whatsappLeads({ api, env, now: DAY_AM, leads: [L("1", { first_name: "mei", phone_number: "91234567", email: "m@x.co" }), L("2", { first_name: "Same", phone_number: "+65 9123 4567" })], summary, log: () => {} });
  assert.equal(summary.whatsapped, 1, "two leads with one number get one message");
  const t = api.calls.find((c) => c[0] === "template");
  assert.equal(t[1], 500);
  assert.deepEqual(t[2], { name: "redlight_lead_welcome", language: "en", body: { 1: "Mei" }, content: "Hi Mei! Thanks.\n\n- Zoey" });
  assert.deepEqual(api.calls.find((c) => c[0] === "labels")[2], ["lead-form", "no-followup"]);
  assert.equal(api.calls.find((c) => c[0] === "conversation")[1].source_id, "src");
});

test("never twice, never at night, nobody when the sent list can't be read", async () => {
  const s1 = { whatsapped: 0, skipped: 0, errors: [] };
  await whatsappLeads({ api: fakeApi({ sentPhones: ["+6591234567"] }), env, now: DAY_AM, leads: [L("1", { first_name: "Mei", phone_number: "91234567" })], summary: s1 });
  assert.equal(s1.whatsapped, 0);
  const night = fakeApi();
  await whatsappLeads({ api: night, env, now: 1_800_000_000 + 8 * 3600, leads: [L("1", { first_name: "Mei", phone_number: "91234567" })], summary: s1 });
  assert.equal(night.calls.length, 0);
  const broken = { ...fakeApi(), labelled: async () => { throw new Error("down"); } };
  const s2 = { whatsapped: 0, skipped: 0, errors: [] };
  await whatsappLeads({ api: broken, env, now: DAY_AM, leads: [L("1", { first_name: "Mei", phone_number: "91234567" })], summary: s2 });
  assert.equal(s2.whatsapped, 0);
  assert.equal(s2.errors.length, 1);
});

test("no usable first name: 'there'", () => {
  assert.equal(leadTemplate({ LEAD_TEMPLATE: "x" }, "there").body[1], "there");
});
