import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { INBOX, firstName, followup1, kindOf, tpl } from "../src/templates.js";
import { tick } from "../src/cx.js";
import { createChatwoot } from "../src/chatwoot.js";
import { run } from "../src/index.js";

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
      labelled: async () => labelled,
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

test("it gives the CX chat's own watcher the first turn, and looks again right before sending", async () => {
  // Under 75 seconds old: wait.
  const young = fake({ open: [conv(1, INBOX.waCx, "Amy")], threads: { 1: [msg(11, 0, CLAIM, 40)] } });
  await go(young);
  assert.deepEqual(young.sent, []);
  await tick({ api: young.api, options: { dryRun: false, now: NOW + 60 }, log: () => {} }); // a minute later
  assert.equal(young.sent.length, 1);

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
