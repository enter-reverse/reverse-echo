import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { INBOX, TEMPLATES, firstName, followup1, kindOf, tpl } from "../src/templates.js";
import { tick } from "../src/cx.js";
import { createChatwoot } from "../src/chatwoot.js";
import worker, { run } from "../src/index.js";
import { buyerKeys, markPaid, verify } from "../src/shopify.js";
import { createHmac } from "node:crypto";

// What the original Python watcher (cx-watch/autoreply.py) itself produces.
const golden = JSON.parse(await readFile(new URL("./golden.json", import.meta.url), "utf8"));

test("names, message kinds and every template match the original watcher exactly", () => {
  for (const [name, want] of golden.first_name) assert.equal(firstName(name), want, `firstName(${JSON.stringify(name)})`);
  for (const [text, inbox, want] of golden.kind_of) assert.equal(kindOf(text, inbox), want, `kindOf(${JSON.stringify(text)}, ${inbox})`);
  for (const [kind, name, want] of golden.tpl) assert.equal(tpl(kind, name), want, `tpl(${kind}, ${JSON.stringify(name)})`);
});

test("the day-1 follow-up is the approved line, with and without a name", () => {
  assert.equal(followup1("El"), "Hi El, your $100 off is still saved for you. Any questions about how it works, just ask me here :)");
  assert.equal(followup1(""), "Hi! Your $100 off is still saved for you. Any questions about how it works, just ask me here :)");
  for (const k of ["trial", "hbot", "red", "float", "duo"]) assert.equal(tpl(k, "A").match(/https?:\/\//g).length, 1, `${k}: one link`);
});

const NOW = 1_800_000_000;
const CLAIM = "Hi Zoey! I'd like to claim my $100 off HBOT, $199 for my first month. My goal: more energy.";
const conv = (id, inbox, name, extra = {}) => ({ id, inbox_id: inbox, last_activity_at: NOW - 30, labels: [], meta: { sender: { name } }, ...extra });
const msg = (id, type, content, ago) => ({ id, message_type: type, content, created_at: NOW - ago });

function fake({ open = [], labelled = [], threads = {} }) {
  const sent = [];
  const labels = {};
  return {
    sent, labels,
    api: {
      conversations: async (status) => (status === "open" ? open : []),
      labelled: async (_l, page = 1) => labelled.slice((page - 1) * 25, page * 25),
      sendTemplate: async (cid, t) => { sent.push({ cid, template: t.name, body: t.body, content: t.content }); (threads[cid] ??= []).push(msg(9500 + sent.length, 1, t.content, 0)); },
      messages: async (cid) => [...(threads[cid] ?? [])].sort((a, b) => a.created_at - b.created_at),
      send: async (cid, content) => { sent.push({ cid, content }); (threads[cid] ??= []).push(msg(9000 + sent.length, 1, content, 0)); },
      addLabels: async (cid, l) => { labels[cid] = [...new Set([...(labels[cid] ?? []), ...l])]; },
    },
  };
}
const go = (f, options = {}) => tick({ api: f.api, options: { dryRun: false, now: NOW, ...options }, log: () => {} });

test("a fresh website claim and a TRIAL message each get their reply once, and are labelled", async () => {
  const f = fake({
    open: [conv(1, INBOX.waCx, "glory santosh"), conv(2, INBOX.instagram, "🍀"), conv(3, INBOX.waCx, "Tim")],
    threads: { 1: [msg(11, 0, CLAIM, 120)], 2: [msg(21, 0, "TRIAL", 90)], 3: [msg(31, 0, "what time do you open?", 90)] },
  });
  const s = await go(f);
  assert.deepEqual(f.sent.map((x) => x.cid), [1, 2]);
  assert.equal(f.sent[0].content, tpl("hbot", "Glory"));
  assert.equal(f.sent[1].content, tpl("trial", ""));
  assert.deepEqual(f.labels, { 1: ["claim"], 2: ["trial"] });
  assert.equal(s.autoSent, 2);
  await go(f); // the next minute
  assert.equal(f.sent.length, 2, "never replies twice");
});

test("no auto-reply where we've already written, on the store's WhatsApp, to stale messages, or in dry run", async () => {
  const threads = {
    1: [msg(11, 0, CLAIM, 600), msg(12, 1, "Hi!", 500), msg(13, 0, "trial", 120)], // we've written here
    2: [msg(21, 0, CLAIM, 120)], // Joo Chiat's own WhatsApp
    3: [msg(31, 0, CLAIM, 3 * 3600)], // hours old: a person decides
    4: [msg(41, 0, CLAIM, 120)], // already replied per Chatwoot
  };
  const f = fake({
    open: [conv(1, INBOX.waCx, "A"), conv(2, INBOX.waJooChiat, "B"), conv(3, INBOX.waCx, "C"), conv(4, INBOX.waCx, "D", { first_reply_created_at: NOW - 10 })],
    threads,
  });
  await go(f);
  assert.deepEqual(f.sent, []);
  const g = fake({ open: [conv(5, INBOX.waCx, "Eve")], threads: { 5: [msg(51, 0, CLAIM, 120)] } });
  await tick({ api: g.api, options: { now: NOW }, log: () => {} }); // dryRun defaults to true
  assert.deepEqual(g.sent, []);
});

test("a Duo claim gets the Duo reply and is kept out of the $100 follow-up", async () => {
  const f = fake({ open: [conv(1, INBOX.waCx, "Sam")], threads: { 1: [msg(11, 0, "Hi Zoey! We'd like to claim our $299 off HBOT for two, $299 for our first month.", 120)] } });
  await go(f);
  assert.equal(f.sent[0].content, tpl("duo", "Sam"));
  assert.deepEqual(f.labels[1], ["claim", "duo"]);
});

test("a message is answered on the next pass; an optional wait and the last-second re-check still work", async () => {
  // Seconds old: answered straight away.
  const fresh = fake({ open: [conv(1, INBOX.waCx, "Amy")], threads: { 1: [msg(11, 0, CLAIM, 5)] } });
  await go(fresh);
  assert.equal(fresh.sent.length, 1);

  // With a wait configured, a young message is left for the next pass.
  const waiting = fake({ open: [conv(3, INBOX.waCx, "Cy")], threads: { 3: [msg(31, 0, CLAIM, 40)] } });
  await go(waiting, { minAgeSecs: 75 });
  assert.deepEqual(waiting.sent, []);

  // A reply lands between this pass reading the chat and sending: don't send a second one.
  const raced = fake({ open: [conv(2, INBOX.waCx, "Bo")], threads: { 2: [msg(21, 0, CLAIM, 120)] } });
  let reads = 0;
  const read = raced.api.messages;
  raced.api.messages = async (cid) => {
    if (++reads === 2) return [...(await read(cid)), msg(22, 1, "Hi Bo, you're in!", 1)];
    return read(cid);
  };
  await go(raced);
  assert.deepEqual(raced.sent, []);
});

const H = 3600;
const claimThread = (claimAgo, extra = []) => [msg(1, 0, CLAIM, claimAgo), msg(2, 1, tpl("hbot", "El"), claimAgo - 60), ...extra];
const claimConv = (id, name, labels = ["claim"], inbox = INBOX.waCx) => conv(id, inbox, name, { labels, last_activity_at: NOW - 20 * H });

test("the day-1 follow-up goes to a quiet WhatsApp claimer about 20 hours in, once", async () => {
  const f = fake({ labelled: [claimConv(7, "el")], threads: { 7: claimThread(21 * H) } });
  const s = await go(f, { followups: true });
  assert.deepEqual(f.sent, [{ cid: 7, content: followup1("El") }]);
  assert.equal(s.followupsSent, 1);
  assert.deepEqual(f.labels[7], ["fu1"]);
  await go(f, { followups: true });
  assert.equal(f.sent.length, 1, "not sent twice even if the label were missing");
});

test("no follow-up when it's too early, they replied, we already followed up, the window shut, or it's off", async () => {
  const cases = {
    1: claimThread(19 * H), // too early
    2: claimThread(21 * H, [msg(3, 0, "how do I book?", 2 * H)]), // they wrote last
    3: claimThread(21 * H, [msg(3, 1, "Hi El, your $100 off is still saved for you.", 1 * H)]), // done by hand
    4: claimThread(25 * H), // WhatsApp window shut
    5: claimThread(21 * H, [msg(3, 0, "ok thanks", 3 * H), msg(4, 1, "Anytime!", 3 * H - 60)]), // chatted since: window open till later, not due yet
  };
  const f = fake({ labelled: Object.keys(cases).map((id) => claimConv(Number(id), "El")), threads: cases });
  await go(f, { followups: true });
  assert.deepEqual(f.sent, []);
  const off = fake({ labelled: [claimConv(7, "El")], threads: { 7: claimThread(21 * H) } });
  await go(off); // followups not switched on
  assert.deepEqual(off.sent, []);
});

test("paid, no-followup, Duo and Instagram claimers are never followed up automatically", async () => {
  const mk = (id, labels, inbox) => claimConv(id, "El", labels, inbox);
  const f = fake({
    labelled: [mk(1, ["claim", "paid"]), mk(2, ["claim", "no-followup"]), mk(3, ["claim", "duo"]), mk(4, ["claim"], INBOX.instagram), mk(5, ["claim", "fu1"])],
    threads: Object.fromEntries([1, 2, 3, 4, 5].map((id) => [id, claimThread(21 * H)])),
  });
  await go(f, { followups: true });
  assert.deepEqual(f.sent, []);
});

test("the Worker stays in dry run unless told otherwise, and talks to Chatwoot the way the original did", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ line: `${init.method} ${u.pathname}${u.search}`, headers: init.headers, body: init.body });
    const body = u.pathname.endsWith("/conversations") && u.searchParams.get("status") === "open"
      ? { data: { payload: [{ id: 5, inbox_id: INBOX.waCx, last_activity_at: Math.floor(Date.now() / 1000), meta: { sender: { name: "amy" } } }] } }
      : u.pathname.endsWith("/conversations") ? { data: { payload: [] } }
      : u.pathname.endsWith("/messages") && init.method === "GET" ? { payload: [{ id: 1, message_type: 0, content: CLAIM, created_at: Math.floor(Date.now() / 1000) - 120 }, { id: 2, message_type: 2, content: "activity", created_at: 1 }] }
      : u.pathname.endsWith("/labels") && init.method === "GET" ? { payload: ["vip"] }
      : { id: 77 };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const env = { CW_TOKEN: "tok", CW_ACC: "42" };
  await run(env, { fetchImpl, log: () => {} });
  assert.ok(!calls.some((c) => c.line.startsWith("POST")), "dry run must not send");
  await run({ ...env, DRY_RUN: "0" }, { fetchImpl, log: () => {} });
  const posts = calls.filter((c) => c.line.startsWith("POST"));
  assert.equal(posts[0].line, "POST /api/v1/accounts/42/conversations/5/messages");
  assert.deepEqual(JSON.parse(posts[0].body), { content: tpl("hbot", "Amy"), message_type: "outgoing", private: false });
  assert.equal(posts[0].headers.api_access_token, "tok");
  assert.deepEqual(JSON.parse(posts[1].body), { labels: ["vip", "claim"] });
  assert.throws(() => createChatwoot({ token: "", account: "" }), /CW_TOKEN/);
});

test("a paid Shopify order labels the buyer's chats, matching only an exact phone or email", async () => {
  const order = { email: "Amy@Example.com", phone: "+65 8123 4567", customer: { phone: "81234567" } };
  assert.deepEqual(buyerKeys(order), { phones: ["81234567"], emails: ["amy@example.com"] });
  const labels = {};
  const api = {
    searchContacts: async (q) => q === "81234567"
      ? [{ id: 1, phone_number: "+6581234567" }, { id: 2, phone_number: "+6599981234" }]
      : [{ id: 1, email: "amy@example.com" }, { id: 3, email: "amy@example.com.sg" }],
    contactConversations: async (id) => (id === 1 ? [{ id: 10, labels: ["claim"] }, { id: 11, labels: ["paid"] }] : [{ id: 99, labels: [] }]),
    addLabels: async (cid, l) => { labels[cid] = l; },
  };
  const r = await markPaid({ api, order, log: () => {} });
  assert.deepEqual(labels, { 10: ["paid"] });
  assert.deepEqual(r, { matchedContacts: 1, labelled: 1 });
});

test("the Shopify address only accepts requests signed with the secret", async () => {
  const body = JSON.stringify({ email: "x@y.z" });
  const secret = "s3cret";
  const good = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(await verify(body, good, secret), true);
  assert.equal(await verify(body + " ", good, secret), false);
  assert.equal(await verify(body, good, "other"), false);
  const env = { SHOPIFY_WEBHOOK_SECRET: secret, CW_TOKEN: "t", CW_ACC: "1", DRY_RUN: "1" };
  const ctx = { waitUntil: (p) => p.catch(() => {}) };
  const post = (headers) => worker.fetch(new Request("https://x/shopify", { method: "POST", body, headers }), env, ctx);
  assert.equal((await post({ "X-Shopify-Hmac-Sha256": "wrong" })).status, 401);
  assert.equal((await post({})).status, 401);
  assert.equal((await worker.fetch(new Request("https://x/shopify", { method: "POST", body }), { ...env, SHOPIFY_WEBHOOK_SECRET: "" }, ctx)).status, 503);
  assert.equal((await worker.fetch(new Request("https://x/"), env, ctx)).status, 200);
});

// 1_800_000_000 is 12:00 in Singapore, inside the daytime hours.
const D = 24 * H;
const oldClaim = (id, name, days, labels = ["claim"], inbox = INBOX.waCx) => conv(id, inbox, name, { labels, last_activity_at: NOW - days * D + 60 });
const both = { templates: { day3: true, day5: true } };

test("days 3 and 5 go out as templates, once each, only in the day they fall due", async () => {
  const f = fake({
    labelled: [oldClaim(1, "jenny tan", 3.2), oldClaim(2, "Sam", 5.5), oldClaim(3, "Old", 5.9), oldClaim(4, "Early", 2.5)],
    threads: { 1: claimThread(3.2 * D), 2: claimThread(5.5 * D), 3: claimThread(9 * D), 4: claimThread(2.5 * D) },
  });
  const s = await go(f, both);
  assert.deepEqual(f.sent.map((x) => [x.cid, x.template]), [[1, "claim_followup_day3"], [2, "claim_followup_day5"]]);
  assert.deepEqual(f.sent[0].body, { 1: "Jenny" });
  assert.equal(f.sent[0].content, TEMPLATES.day3.text("Jenny"));
  assert.ok(f.sent[0].content.endsWith("let my team know to expect you!"));
  assert.deepEqual(f.labels, { 1: ["fu3"], 2: ["fu5"] });
  assert.equal(s.templatesSent, 2);
});

test("no template when it's off, at night, they wrote last, we just wrote, they paid, or there's no name", async () => {
  const quiet = () => fake({ labelled: [oldClaim(1, "Jo", 3.2)], threads: { 1: claimThread(3.2 * D) } });
  let f = quiet(); await go(f); assert.deepEqual(f.sent, [], "off by default");
  f = quiet(); await go(f, { templates: { day5: true } }); assert.deepEqual(f.sent, [], "only day 5 is on");
  f = quiet(); await go(f, { ...both, now: NOW + 14 * H }); assert.deepEqual(f.sent, [], "2am in Singapore");
  f = quiet(); await go(f, { ...both, dryRun: true }); assert.deepEqual(f.sent, [], "dry run");
  f = fake({ labelled: [oldClaim(1, "Jo", 3.2)], threads: { 1: claimThread(3.2 * D, [msg(3, 0, "is parking free?", 3.1 * D)]) } });
  await go(f, both); assert.deepEqual(f.sent, [], "they wrote last");
  f = fake({ labelled: [oldClaim(1, "Jo", 3.2)], threads: { 1: claimThread(3.2 * D, [msg(3, 1, "hello again", 2 * H)]) } });
  await go(f, both); assert.deepEqual(f.sent, [], "we wrote two hours ago");
  for (const l of ["paid", "no-followup", "fu3"]) {
    f = fake({ labelled: [oldClaim(1, "Jo", 3.2, ["claim", l])], threads: { 1: claimThread(3.2 * D) } });
    await go(f, both); assert.deepEqual(f.sent, [], l);
  }
  f = fake({ labelled: [oldClaim(1, "S", 3.2), oldClaim(2, "Ig", 3.2, ["claim"], INBOX.instagram)], threads: { 1: claimThread(3.2 * D), 2: claimThread(3.2 * D) } });
  await go(f, both); assert.deepEqual(f.sent, [], "a one-letter name, and Instagram");
});

test("a Duo claimer gets the day-3 invite but not the $100 day-5 note; claims past the first page are reached", async () => {
  const filler = Array.from({ length: 25 }, (_, i) => conv(100 + i, INBOX.waCx, "New", { labels: ["claim"] }));
  const f = fake({
    labelled: [...filler, oldClaim(1, "Duo", 3.2, ["claim", "duo"]), oldClaim(2, "Pair", 5.2, ["claim", "duo", "fu3"])],
    threads: { 1: claimThread(3.2 * D), 2: claimThread(5.2 * D) },
  });
  await go(f, both);
  assert.deepEqual(f.sent.map((x) => [x.cid, x.template]), [[1, "claim_followup_day3"]]);
});

test("a template is sent to Chatwoot in the shape its API expects", async () => {
  const calls = [];
  const api = createChatwoot({ token: "t", account: 1, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("{}"); } });
  await api.sendTemplate(7, { name: "claim_followup_day3", body: { 1: "Jo" }, content: "Hi Jo" });
  assert.ok(calls[0].url.endsWith("/conversations/7/messages"));
  assert.deepEqual(calls[0].body, { content: "Hi Jo", message_type: "outgoing", private: false,
    template_params: { name: "claim_followup_day3", category: "MARKETING", language: "en", processed_params: { body: { 1: "Jo" } } } });
});

const M = 60;
const alertsOn = { alerts: { conversation: 410, account: "197246" } };
const waitingConv = (id, name, ago, inbox = INBOX.waCx, extra = {}) => conv(id, inbox, name, { last_activity_at: NOW - ago, first_reply_created_at: NOW - 9000, ...extra });
const answered = (ago) => [msg(1, 0, "hi", ago + 600), msg(2, 1, "Hi! How can I help?", ago + 500)];

test("the owner is pinged once, at 20 minutes, for a customer still waiting (no 10-minute ping since 22 Nov)", async () => {
  const thread = (ago) => ({ 7: [...answered(ago), msg(3, 0, "is parking free?\nthanks", ago)] });
  let f = fake({ open: [waitingConv(7, "Jo Tan", 20 * M + 20)], threads: thread(20 * M + 20) });
  const s = await go(f, alertsOn);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].cid, 410);
  assert.ok(f.sent[0].content.startsWith("Unanswered 20 min\n\nJo Tan on WhatsApp, since "));
  assert.ok(f.sent[0].content.includes('"is parking free? thanks"'));
  assert.ok(f.sent[0].content.endsWith("https://app.chatwoot.com/app/accounts/197246/conversations/7"));
  assert.equal(s.alertsSent, 1);
  for (const ago of [9 * M + 30, 10 * M + 20, 11 * M + 5, 15 * M, 19 * M + 59, 21 * M + 1]) {
    f = fake({ open: [waitingConv(7, "Jo", ago)], threads: thread(ago) });
    await go(f, alertsOn); assert.deepEqual(f.sent, [], `${ago}s old: not the 20-minute mark`);
  }
});

test("no ping once we've replied, for team chats, the store's WhatsApp, the alert chat itself, when off or in dry run", async () => {
  const waiting = (ago) => [...answered(ago), msg(3, 0, "hello?", ago)];
  let f = fake({ open: [waitingConv(7, "Jo", 20 * M + 20)], threads: { 7: [...waiting(20 * M + 20), msg(4, 1, "Yes it is!", 60)] } });
  await go(f, alertsOn); assert.deepEqual(f.sent, [], "replied");
  f = fake({
    open: [waitingConv(158, "Andre", 20 * M + 20), waitingConv(410, "Elijah", 20 * M + 20), waitingConv(9, "Walk-in", 20 * M + 20, INBOX.waJooChiat)],
    threads: { 158: waiting(20 * M + 20), 410: waiting(20 * M + 20), 9: waiting(20 * M + 20) },
  });
  await go(f, alertsOn); assert.deepEqual(f.sent, []);
  f = fake({ open: [waitingConv(7, "Jo", 20 * M + 20)], threads: { 7: waiting(20 * M + 20) } });
  await go(f); assert.deepEqual(f.sent, [], "alerts off");
  await go(f, { ...alertsOn, dryRun: true }); assert.deepEqual(f.sent, [], "dry run");
});

test("a TRIAL or claim message nobody auto-answered raises the 5-minute alarm; an alert that can't be delivered is reported", async () => {
  // Older than the 15-minute auto-reply cut-off would be ignored; this one is 5 minutes old in a chat the robot is not allowed to answer (dry run elsewhere).
  const f = fake({ open: [conv(5, INBOX.instagram, "Kai", { last_activity_at: NOW - 5 * M - 10, first_reply_created_at: NOW - 100 })], threads: { 5: [msg(1, 0, "TRIAL", 5 * M + 10)] } });
  await go(f, alertsOn);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].content.startsWith("No auto-reply after 5 min (trial)\n\nKai on Instagram"));

  // A fresh claim is answered in the same pass, so there is nothing to alert about.
  const ok = fake({ open: [conv(6, INBOX.waCx, "Amy", { last_activity_at: NOW - 5 * M - 10 })], threads: { 6: [msg(1, 0, CLAIM, 5 * M + 10)] } });
  await go(ok, alertsOn);
  assert.deepEqual(ok.sent.map((x) => x.cid), [6]);

  const shut = fake({ open: [waitingConv(7, "Jo", 20 * M + 20)], threads: { 7: [...answered(20 * M + 20), msg(3, 0, "hello?", 20 * M + 20)] } });
  shut.api.send = async () => { throw new Error("Chatwoot POST /conversations/410/messages -> HTTP 422"); };
  const s = await go(shut, alertsOn);
  assert.equal(s.alertsSent, 0);
  assert.match(s.errors[0], /ALERT NOT DELIVERED for conversation 7/);
});

test("a day-old claim past the first page still gets its follow-up, and later passes give way when requests run low", async () => {
  const filler = Array.from({ length: 25 }, (_, i) => conv(200 + i, INBOX.waCx, "New", { labels: ["claim"] }));
  const f = fake({ labelled: [...filler, claimConv(1, "El")], threads: { 1: claimThread(21 * H) } });
  await go(f, { followups: true });
  assert.deepEqual(f.sent.map((x) => x.cid), [1]);

  const tight = fake({ labelled: [claimConv(1, "El")], threads: { 1: claimThread(21 * H) } });
  tight.api.used = () => 45;
  const s = await go(tight, { followups: true });
  assert.deepEqual(tight.sent, []);
  assert.equal(s.skipped, 1);
});

// NOW is 4:00pm in Singapore.
test("the day-1 follow-up never goes out at night, and a small-hours claimer gets it that evening instead", async () => {
  const at = (hoursFromNow, claimAgoH) => {
    const now = NOW + hoursFromNow * H;
    const t = (agoH) => ({ created_at: now - agoH * H });
    const f = fake({
      labelled: [conv(1, INBOX.waCx, "El", { labels: ["claim"], last_activity_at: now - claimAgoH * H + 60 })],
      threads: { 1: [{ id: 1, message_type: 0, content: CLAIM, ...t(claimAgoH) }, { id: 2, message_type: 1, content: tpl("hbot", "El"), created_at: now - claimAgoH * H + 60 }] },
    });
    return go(f, { followups: true, now }).then(() => f.sent.length);
  };
  assert.equal(await at(0, 21), 1, "4pm, claimed 21 hours ago: due, sent");
  assert.equal(await at(10, 21), 0, "2am: due, but it is night");
  assert.equal(await at(17.5, 23.5), 1, "9:30am: sent in the morning, before the window shuts");
  assert.equal(await at(3.5, 14), 1, "7:30pm, claimed at 5:30am: tomorrow morning is too late, so tonight");
  assert.equal(await at(3.5, 8), 0, "7:30pm, claimed at 11:30am: tomorrow morning is still in time");
  assert.equal(await at(1, 14), 0, "5pm, claimed at 3am: not yet the last two hours of the evening");
});

test("a claim that starts an Instagram DM (from a chat ad) gets the claim reply, but no WhatsApp follow-ups", async () => {
  const text = "Hi Zoey! I'd like to claim my $100 off Red Light, $199 for my first month.";
  const f = fake({ open: [conv(8, INBOX.instagram, "Mei Ling")], threads: { 8: [msg(1, 0, text, 30)] } });
  await go(f);
  assert.deepEqual(f.sent.map((x) => x.cid), [8]);
  assert.match(f.sent[0].content, /Red Light/);
});

test("the Red Light ad's 'find out more' tap gets the nameless enquiry reply and an enquiry label, not a claim", async () => {
  const text = "I'd like to find out more about the red light experience at Reverse!";
  assert.equal(kindOf(text, INBOX.instagram), "red_info");
  assert.equal(kindOf(text.replace("'", "’"), INBOX.waCx), "red_info");
  assert.equal(kindOf("I'd like to find out more about the red light experience at Reverse! Is it safe?", INBOX.instagram), null);
  const f = fake({ open: [conv(9, INBOX.instagram, "Mei Ling")], threads: { 9: [msg(1, 0, text, 30)] } });
  await go(f);
  assert.deepEqual(f.sent.map((x) => x.cid), [9]);
  assert.ok(f.sent[0].content.startsWith("Hey! I'm Zoey from Reverse. Our Redlight bed is full-body"));
  assert.ok(!f.sent[0].content.includes("Mei"));
  assert.ok(f.sent[0].content.endsWith("- Zoey"));
});

test("the 'Hi Reverse Team!' taps: find out more gets the enquiry reply, claim gets the Red Light claim reply", async () => {
  assert.equal(kindOf("Hi Reverse Team! I'd like to find out more about the red light experience!", INBOX.instagram), "red_info");
  assert.equal(kindOf("Hi Reverse Team! I'd like to know more about the redlight experience at Reverse!", INBOX.instagram), "red_info");
  assert.equal(kindOf("Hi Reverse Team! I'd like to claim my $100 off Red Light.", INBOX.instagram), "red");
  assert.equal(kindOf("Hi Reverse Team! I'd like to know more about the Redlight experience at Reverse!", INBOX.instagram), "red_info");
  assert.equal(kindOf("Hi Reverse Team! I'd like to claim my $100 off Redlight.", INBOX.instagram), "red");
  assert.equal(kindOf("Hi Reverse Team! I'd like to claim my $100 off Red Light.", INBOX.email), null);
  assert.equal(kindOf("Hi Reverse Team! I'd like to claim my $100 off Red Light. When can I come?", INBOX.instagram), null);
});
