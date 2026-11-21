import { test } from "node:test";
import assert from "node:assert/strict";
import { cameFrom, countPass, journey, lastTotal, passDelta } from "../src/passes.js";

const NOW = 1_800_000_000;
const line = (title, quantity = 1) => ({ sku: "100116_5750520_1", title, quantity });
const order = (extra = {}) => ({
  name: "#2700", email: "amy@example.com", total_price: "199.00", financial_status: "paid", created_at: new Date(NOW * 1000).toISOString(),
  customer: { first_name: "Amy Tan", phone: "+6581234567" }, line_items: [line("All-Access Pass · First month")], ...extra,
});

test("what each order adds: All-Access 1, Duo 2, Red Light and team tests nothing", () => {
  assert.deepEqual(passDelta(order()), { kind: "All-Access", n: 1 });
  assert.deepEqual(passDelta(order({ total_price: "299.00", line_items: [line("All-Access Pass · First month", 2)] })), { kind: "Duo", n: 2 });
  assert.deepEqual(passDelta(order({ line_items: [line("8 RLT/mth – 30-day trial")] })), { kind: "Red Light", n: 0 });
  assert.equal(passDelta(order({ total_price: "0.00" })).n, 0);
  assert.equal(passDelta(order({ total_price: "1.00" })).n, 0);
  assert.equal(passDelta(order({ line_items: [line("TEST to see 🤔")] })).n, 0);
  assert.equal(passDelta(order({ email: "andre@enterreverse.com" })).n, 0);
  assert.equal(passDelta(order({ cancelled_at: "2026-11-22T00:00:00Z" })).n, 0);
  assert.deepEqual(passDelta(order({ line_items: [{ sku: "100107_5750520_1", title: "Contrast Session (75 mins)" }] })), { kind: null, n: 0 });
});

test("where they came from, from the order alone", () => {
  assert.equal(cameFrom({ landing_site: "/cart/c/x?utm_campaign=all-access-pass&utm_content=e10-faq&utm_medium=email&" }), "an email link (all-access-pass, e10-faq)");
  assert.equal(cameFrom({ landing_site: "/cart/c/x?fbclid=abc&key=1", referring_site: "https://pass.enterreverse.com/" }), "a Facebook/Instagram ad via pass.enterreverse.com (ad name not in the order)");
  assert.equal(cameFrom({ source_name: "pos" }), "the studio (paid in person)");
  assert.equal(cameFrom({}), null);
});

test("the running total comes from the last Total line we sent, notes included", () => {
  const ms = [{ message_type: 1, content: "New pass: A\nTotal: 61" }, { message_type: 0, content: "ok" }, { message_type: 1, content: "hello" }];
  assert.equal(lastTotal(ms, 50), 61);
  assert.equal(lastTotal([], 50), 50);
});

function fakeApi({ userThread = [], contacts = {}, convs = {}, threads = {} } = {}) {
  const sent = [];
  const notes = [];
  return {
    sent, notes,
    allMessages: async (cid) => userThread,
    messages: async (cid) => threads[cid] ?? [],
    searchContacts: async (q) => contacts[q] ?? [],
    contactConversations: async (id) => convs[id] ?? [],
    send: async (cid, content) => { sent.push({ cid, content }); },
    note: async (cid, content) => { notes.push({ cid, content }); },
  };
}
const env = { PASS_ALERT_CONV: "410", PASS_BASE_TOTAL: "61" };
const fromUser = (ago) => ({ message_type: 0, content: "hi", created_at: NOW - ago });

test("a new pass WhatsApps the user the new total and the journey, once", async () => {
  const claimAt = NOW - 3 * 86400;
  const api = fakeApi({
    userThread: [fromUser(3600), { message_type: 1, content: "Total: 61", created_at: NOW - 1800 }],
    contacts: { "81234567": [{ id: 7, phone_number: "+6581234567" }] },
    convs: { 7: [{ id: 70 }] },
    threads: { 70: [
      { message_type: 0, content: "Hi Zoey! I'd like to claim my $100 off HBOT, $199 for my first month.", created_at: claimAt },
      { message_type: 1, content: "Hi Amy, you're in! ...", created_at: claimAt + 30 },
      { message_type: 0, content: "Is the first month a trial?", created_at: claimAt + 600 },
      { message_type: 1, content: "Hi Amy, your $100 off is still saved for you.", created_at: claimAt + 86000 },
    ] },
  });
  const r = await countPass({ api, order: order(), env, now: NOW, log: () => {} });
  assert.deepEqual(r, { counted: 1, sent: true, total: 62 });
  const text = api.sent[0].content;
  assert.equal(api.sent[0].cid, 410);
  assert.match(text, /^🎉 New pass: Amy, All-Access\nTotal: 62\n/);
  assert.match(text, /Claimed \$100 off HBOT on WhatsApp/);
  assert.match(text, /Chat: 2 messages from them, 2 from us; asked: "Is the first month a trial\?"/);
  assert.match(text, /Follow-ups from us: 1/);
  assert.match(text, /First contact to paid: 3 days/);
  assert.match(text, /Order #2700$/);

  // Shopify retries: the same order is never counted twice.
  const again = fakeApi({ userThread: [fromUser(60), { message_type: 1, content: text, created_at: NOW - 10 }] });
  assert.deepEqual(await countPass({ api: again, order: order(), env, now: NOW, log: () => {} }), { counted: 0 });
  assert.equal(again.sent.length, 0);
});

test("a Duo adds 2; a closed WhatsApp window leaves a note that still carries the total", async () => {
  const api = fakeApi({ userThread: [fromUser(2 * 86400), { message_type: 1, private: true, content: "Not sent\nTotal: 63", created_at: NOW - 600 }] });
  const duo = order({ name: "#2701", line_items: [line("All-Access Pass · First month", 2)] });
  const r = await countPass({ api, order: duo, env, now: NOW, log: () => {} });
  assert.deepEqual(r, { counted: 2, sent: false, total: 65 });
  assert.equal(api.sent.length, 0);
  assert.match(api.notes[0].content, /Not sent \(WhatsApp window closed\)[\s\S]*Total: 65/);
});

test("nothing is sent for Red Light, tests, or when the counter is switched off", async () => {
  const api = fakeApi({ userThread: [fromUser(60)] });
  await countPass({ api, order: order({ line_items: [line("8 RLT/mth – 30-day trial")] }), env, now: NOW, log: () => {} });
  await countPass({ api, order: order({ total_price: "0.00" }), env, now: NOW, log: () => {} });
  await countPass({ api, order: order(), env: { PASS_ALERT_CONV: "" }, now: NOW, log: () => {} });
  assert.equal(api.sent.length, 0);
});

test("a buyer with no chat says so plainly instead of guessing", async () => {
  const lines = await journey({ api: fakeApi(), order: order({ landing_site: "/cart/c/x?fbclid=1" }), now: NOW });
  assert.equal(lines[0], "No claim on WhatsApp or Instagram that I can match to them");
  assert.match(lines[1], /Facebook\/Instagram ad/);
  assert.match(lines[2], /Chat: none matched/);
  assert.equal(lines[3], "First contact to paid: not traceable (the order is the first trace)");
});
