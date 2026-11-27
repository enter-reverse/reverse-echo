import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, pending, wanted, STANDBY, NOT_COVERED, NOT_FOR_YOU, TG_INBOX } from "../src/tgbot.js";
import worker from "../src/index.js";

const env = { ANTHROPIC_API_KEY: "k", ZOEY_BOT_KEY: "z", SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pk" };

function fakeApi({ inbox = TG_INBOX, chatId = 313483437, messages }) {
  const sent = [], notes = [];
  const api = {
    sent, notes,
    conversation: async () => ({ inbox_id: inbox, additional_attributes: { chat_id: chatId }, meta: { sender: { id: 99, name: "kris", custom_attributes: {} } } }),
    updated: [],
    updateContact: async (id, body) => { api.updated.push({ id, body }); },
    messages: async () => messages,
    send: async (cid, content) => sent.push(content),
    note: async (cid, content) => notes.push(content),
  };
  return api;
}

function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.includes("zoey_bot_context")) {
      return new Response(JSON.stringify({ playbook: "Drop-in Red Light $70.", chunks: [{ title: "CL: Dry Float Turnover Checklist", heading: "", text: "Wipe the bed" }] }));
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
  };
  f.calls = calls;
  return f;
}

test("only new incoming Telegram messages wake the bot", () => {
  assert.equal(wanted({ event: "message_created", message_type: "incoming", inbox: { id: TG_INBOX }, conversation: { id: 5 } }), true);
  assert.equal(wanted({ event: "message_created", message_type: "outgoing", inbox: { id: TG_INBOX }, conversation: { id: 5 } }), false);
  assert.equal(wanted({ event: "message_created", message_type: "incoming", inbox: { id: 156990 }, conversation: { id: 5 } }), false);
  assert.equal(wanted({ event: "conversation_created", inbox: { id: TG_INBOX }, conversation: { id: 5 } }), false);
});

test("a standby line is not an answer; a real reply is", () => {
  const ms = [
    { message_type: 0, created_at: 1, content: "how to reset dry float" },
    { message_type: 1, created_at: 2, content: `${STANDBY}, I'm checking` },
  ];
  assert.equal(pending(ms).length, 1);
  ms.push({ message_type: 1, created_at: 3, content: "Spray and wipe the bed" });
  assert.equal(pending(ms).length, 0);
});

test("answers a staff question from the context and names the page", async () => {
  const api = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "how to reset dry float room" }] });
  const f = fakeFetch("1. Wipe the bed\n(from: CL: Dry Float Turnover Checklist)");
  const r = await answer({ api, env, cid: 7, fetchImpl: f, log: () => {} });
  assert.equal(api.sent.length, 1);
  assert.match(api.sent[0], /Wipe the bed/);
  assert.equal(r.sent > 0, true);
  const ctxCall = f.calls.find((c) => c.url.includes("zoey_bot_context"));
  assert.deepEqual(ctxCall.body, { p_key: "z", p_q: "how to reset dry float room" });
  const prompt = f.calls.find((c) => c.url.includes("anthropic")).body.messages[0].content;
  assert.match(prompt, /Dry Float Turnover Checklist/);
});

test("not covered: sends the full-timers line and leaves a private gap note", async () => {
  const api = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "can someone with gout do red light" }] });
  await answer({ api, env, cid: 7, fetchImpl: fakeFetch(NOT_COVERED), log: () => {} });
  assert.equal(api.sent[0], NOT_COVERED);
  assert.match(api.notes[0], /Academy gap/);
});

test("bookings are handed to Elijah's Claude with a standby line only", async () => {
  const api = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "book Jane for HBOT tmr 6pm" }] });
  const r = await answer({ api, env, cid: 7, fetchImpl: fakeFetch("HANDOFF"), log: () => {} });
  assert.equal(r.handoff, true);
  assert.ok(api.sent[0].startsWith(STANDBY));
});

test("does nothing when already answered, in a group, outside the inbox, or not configured", async () => {
  const answered = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "hi" }, { message_type: 1, created_at: 2, content: "Hello" }] });
  assert.equal((await answer({ api: answered, env, cid: 1, fetchImpl: fakeFetch("x"), log: () => {} })).skipped, "already answered");
  const group = fakeApi({ chatId: -100123, messages: [{ message_type: 0, created_at: 1, content: "hi" }] });
  assert.equal((await answer({ api: group, env, cid: 1, fetchImpl: fakeFetch("x"), log: () => {} })).skipped, "group chat");
  const wa = fakeApi({ inbox: 156990, messages: [{ message_type: 0, created_at: 1, content: "hi" }] });
  assert.equal((await answer({ api: wa, env, cid: 1, fetchImpl: fakeFetch("x"), log: () => {} })).skipped, "not the Telegram inbox");
  const off = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "hi" }] });
  assert.equal((await answer({ api: off, env: {}, cid: 1, fetchImpl: fakeFetch("x"), log: () => {} })).skipped, "not configured");
  assert.equal(group.sent.length + wa.sent.length + off.sent.length + answered.sent.length, 0);
});

test("dry run sends nothing", async () => {
  const api = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "prices?" }] });
  await answer({ api, env, cid: 7, fetchImpl: fakeFetch("HBOT $150"), log: () => {}, dryRun: true });
  assert.equal(api.sent.length, 0);
});

test("the /tg-bot address ignores non-Telegram events and never touches /shopify", async () => {
  const req = new Request("https://x.test/tg-bot", { method: "POST", body: JSON.stringify({ event: "message_created", message_type: "outgoing" }) });
  const res = await worker.fetch(req, { CW_TOKEN: "t", CW_ACC: "1" }, { waitUntil() {} });
  assert.equal(await res.text(), "ignored");
});

test("a newcomer's introduction is saved as their Chatwoot name", async () => {
  const api = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "I'm Kris, part-time SES" }] });
  const r = await answer({ api, env, cid: 7, fetchImpl: fakeFetch("INTRO: Kris | part-time SES"), log: () => {} });
  assert.equal(r.intro, "Kris");
  assert.equal(api.updated[0].body.name, "Kris (part-time SES)");
  assert.equal(api.updated[0].body.custom_attributes.staff_name, "Kris");
  assert.match(api.sent[0], /Thanks Kris/);
});

test("the prompt says who is asking, or that they are unknown", async () => {
  const api = fakeApi({ messages: [{ message_type: 0, created_at: 1, content: "prices?" }] });
  const f = fakeFetch("HBOT $150");
  await answer({ api, env, cid: 7, fetchImpl: f, log: () => {} });
  const prompt = f.calls.find((c) => c.url.includes("anthropic")).body.messages[0].content;
  assert.match(prompt, /WHO IS ASKING\nunknown \(Telegram name: kris\)/);
});

test("slash commands are for the HQ team only; front of house gets a polite no", async () => {
  const kris = fakeApi({ chatId: 769515809, messages: [{ message_type: 0, created_at: 1, content: "/update" }] });
  const f = fakeFetch("should not be called");
  const r = await answer({ api: kris, env, cid: 7, fetchImpl: f, log: () => {} });
  assert.equal(r.refused, true);
  assert.deepEqual(kris.sent, [NOT_FOR_YOU]);
  assert.equal(f.calls.length, 0);
  // Once refused, the same command isn't answered again.
  const after = fakeApi({ chatId: 769515809, messages: [{ message_type: 0, created_at: 1, content: "/update" }, { message_type: 1, created_at: 2, content: NOT_FOR_YOU }] });
  assert.equal((await answer({ api: after, env, cid: 7, fetchImpl: f, log: () => {} })).skipped, "already answered");
});

test("HQ (founders, Wendy, Shah) can use commands; /start and plain questions stay open to everyone", async () => {
  for (const chatId of [313483437, 1200464601, 823909446]) {
    const hq = fakeApi({ chatId, messages: [{ message_type: 0, created_at: 1, content: "/update" }] });
    const r = await answer({ api: hq, env, cid: 7, fetchImpl: fakeFetch("Here's the update"), log: () => {} });
    assert.equal(r.refused, undefined);
    assert.notEqual(hq.sent[0], NOT_FOR_YOU);
  }
  const start = fakeApi({ chatId: 769515809, messages: [{ message_type: 0, created_at: 1, content: "/start" }] });
  assert.equal((await answer({ api: start, env, cid: 7, fetchImpl: fakeFetch("x"), log: () => {} })).sent, "hello");
  const q = fakeApi({ chatId: 769515809, messages: [{ message_type: 0, created_at: 1, content: "how to reset dry float / red light room" }] });
  await answer({ api: q, env, cid: 7, fetchImpl: fakeFetch("Wipe the bed"), log: () => {} });
  assert.equal(q.sent[0], "Wipe the bed");
});
