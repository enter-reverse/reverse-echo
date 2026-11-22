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
