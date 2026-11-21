import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { containsKeyword, matchRule, validateRules } from "../src/match.js";
import { runOnce, pickReply } from "../src/engine.js";
import { InstagramError, classify, createClient } from "../src/instagram.js";

const rules = validateRules(JSON.parse(await readFile(new URL("../rules.json", import.meta.url), "utf8")));
const NOW = new Date("2026-11-21T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

test("keyword matches as a whole word, any case, punctuation or emoji", () => {
  for (const t of ["TRIAL", "trial", "Trial!!", "  trial  ", "Trial please 🙏", "can I get the trial?", "TRIAL🔥", "#trial", "trial.", "Tríal"]) {
    assert.ok(containsKeyword(t, "trial"), t);
  }
  for (const t of ["trials", "trialling", "entrial", "trail", "", "love this", null]) {
    assert.ok(!containsKeyword(t, "trial"), String(t));
  }
});

test("the shipped rules.json is valid and TRIAL maps to the trial rule", () => {
  assert.equal(matchRule("TRIAL", rules)?.name, "trial");
  assert.equal(matchRule("nice reel", rules), null);
  assert.match(rules[0].dm, /https:\/\/pass\.enterreverse\.com\/gift/);
  assert.equal(rules[0].dm.match(/https?:\/\//g).length, 1, "the link appears once");
});

test("validateRules rejects broken edits with a readable message", () => {
  assert.throws(() => validateRules({}), /non-empty "rules"/);
  assert.throws(() => validateRules({ rules: [{ name: "x", keywords: [], dm: "a", publicReplies: ["b"], fallbackReply: "c" }] }), /keywords/);
  assert.throws(() => validateRules({ rules: [{ name: "x", keywords: ["k"], dm: "", publicReplies: ["b"], fallbackReply: "c" }] }), /dm/);
  assert.throws(() => validateRules({ rules: [{ name: "x", keywords: ["k"], dm: "a".repeat(1001), publicReplies: ["b"], fallbackReply: "c" }] }), /1000/);
  assert.throws(() => validateRules({ rules: [{ name: "x", keywords: ["k"], dm: "a", publicReplies: ["b"] }] }), /fallbackReply/);
});

/** A fake Instagram account. `comments` is { mediaId: [comment] }. */
function fakeApi({ comments, failDm = {}, failReply = {} }) {
  const sent = { dms: [], replies: [] };
  const api = {
    me: async () => ({ username: "enter.reverse", user_id: "1" }),
    recentMedia: async () => Object.keys(comments).map((id) => ({ id, comments_count: comments[id].length })),
    comments: async (id) => comments[id],
    privateReply: async (commentId, text) => {
      if (failDm[commentId]) throw failDm[commentId];
      sent.dms.push({ commentId, text });
    },
    publicReply: async (commentId, text) => {
      if (failReply[commentId]?.length) throw failReply[commentId].shift();
      sent.replies.push({ commentId, text });
    },
  };
  return { api, sent };
}
const comment = (id, username, text, h = 1, replies = []) => ({ id, username, text, timestamp: hoursAgo(h), replies: { data: replies } });
const run = (api, options = {}) => runOnce({ api, rules, options: { now: NOW, ...options }, log: () => {} });

test("a TRIAL comment gets the DM and a public reply; other comments are left alone", async () => {
  const { api, sent } = fakeApi({ comments: { m1: [comment("c1", "amy", "TRIAL"), comment("c2", "bob", "looks great")] } });
  const s = await run(api);
  assert.deepEqual(sent.dms, [{ commentId: "c1", text: rules[0].dm }]);
  assert.equal(sent.replies.length, 1);
  assert.equal(sent.replies[0].commentId, "c1");
  assert.ok(rules[0].publicReplies.includes(sent.replies[0].text));
  assert.deepEqual([s.matched, s.dmSent, s.replied], [1, 1, 1]);
});

test("a comment we already replied under is never answered twice", async () => {
  const { api, sent } = fakeApi({
    comments: { m1: [comment("c1", "amy", "trial", 1, [{ id: "r1", username: "Enter.Reverse" }]), comment("c2", "cat", "trial", 1, [{ id: "r2", username: "someone_else" }])] },
  });
  await run(api);
  assert.deepEqual(sent.dms.map((d) => d.commentId), ["c2"]);
});

test("running twice in a row sends nothing the second time", async () => {
  const comments = { m1: [comment("c1", "amy", "TRIAL")] };
  const { api, sent } = fakeApi({ comments });
  await run(api);
  comments.m1[0].replies.data.push({ id: "r1", username: "enter.reverse" }); // what Instagram would now return
  await run(api);
  assert.equal(sent.dms.length, 1);
  assert.equal(sent.replies.length, 1);
});

test("our own comments, comments past the 7-day window and comments before go-live are skipped", async () => {
  const { api, sent } = fakeApi({
    comments: { m1: [comment("c1", "enter.reverse", "Comment TRIAL to try"), comment("c2", "old", "trial", 24 * 7), comment("c3", "prelaunch", "trial", 5), comment("c4", "new", "trial", 1)] },
  });
  const s = await run(api, { ignoreBefore: new Date(NOW - 2 * 3600e3) });
  assert.deepEqual(sent.dms.map((d) => d.commentId), ["c4"]);
  assert.equal(s.skippedOld, 2);
});

test("dry run sends nothing", async () => {
  const { api, sent } = fakeApi({ comments: { m1: [comment("c1", "amy", "TRIAL")] } });
  const s = await run(api, { dryRun: true });
  assert.deepEqual(sent, { dms: [], replies: [] });
  assert.equal(s.matched, 1);
});

test("a rate-limited DM is left for the next run, with no public reply", async () => {
  const { api, sent } = fakeApi({
    comments: { m1: [comment("c1", "amy", "TRIAL")] },
    failDm: { c1: new InstagramError("rate limited", { status: 400, code: 4, kind: "transient" }) },
  });
  const s = await run(api);
  assert.deepEqual(sent, { dms: [], replies: [] });
  assert.equal(s.deferred, 1);
});

test("a DM that can never be delivered gets the fallback public reply", async () => {
  const { api, sent } = fakeApi({
    comments: { m1: [comment("c1", "amy", "TRIAL")] },
    failDm: { c1: new InstagramError("cannot message this user", { status: 400, code: 10, kind: "permanent" }) },
  });
  const s = await run(api);
  assert.deepEqual(sent.replies, [{ commentId: "c1", text: rules[0].fallbackReply }]);
  assert.equal(s.fallback, 1);
});

test("a rejected token stops the whole run", async () => {
  const { api } = fakeApi({
    comments: { m1: [comment("c1", "amy", "TRIAL")] },
    failDm: { c1: new InstagramError("token expired", { status: 400, code: 190, kind: "auth" }) },
  });
  await assert.rejects(run(api), /token expired/);
});

test("the public reply is retried once; someone who comments twice gets one DM", async () => {
  const { api, sent } = fakeApi({
    comments: { m1: [comment("c1", "amy", "TRIAL"), comment("c2", "amy", "trial pls")] },
    failReply: { c1: [new InstagramError("blip", { status: 500, kind: "transient" })] },
  });
  await run(api);
  assert.equal(sent.dms.length, 1);
  assert.deepEqual(sent.replies.map((r) => r.commentId), ["c1", "c2"]);
});

test("maxActions caps a run and reports the rest as deferred", async () => {
  const many = Array.from({ length: 5 }, (_, i) => comment(`c${i}`, `u${i}`, "trial"));
  const { api, sent } = fakeApi({ comments: { m1: many } });
  const s = await run(api, { maxActions: 2 });
  assert.equal(sent.dms.length, 2);
  assert.equal(s.deferred, 3);
});

test("pickReply is stable per comment and stays inside the list", () => {
  const list = ["a", "b", "c"];
  assert.equal(pickReply(list, "178"), pickReply(list, "178"));
  for (const id of ["1", "22", "333", "17900000000000001"]) assert.ok(list.includes(pickReply(list, id)));
});

test("error classification and the HTTP client's request shapes", async () => {
  assert.equal(classify(400, 190), "auth");
  assert.equal(classify(400, 4), "transient");
  assert.equal(classify(503, undefined), "transient");
  assert.equal(classify(400, 100), "permanent");

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), ...init });
    if (String(url).includes("/bad/")) return new Response(JSON.stringify({ error: { message: "nope", code: 190 } }), { status: 400 });
    return new Response(JSON.stringify({ data: [], id: "x" }), { status: 200 });
  };
  const api = createClient({ token: "T", fetchImpl });
  await api.privateReply("c9", "hello");
  await api.publicReply("c9", "Sent you a DM!");
  await api.comments("m9");
  assert.equal(calls[0].url, "https://graph.instagram.com/v25.0/me/messages");
  assert.deepEqual(JSON.parse(calls[0].body), { recipient: { comment_id: "c9" }, message: { text: "hello" } });
  assert.equal(calls[0].headers.Authorization, "Bearer T");
  assert.equal(calls[1].url, "https://graph.instagram.com/v25.0/c9/replies");
  assert.match(calls[2].url, /m9\/comments\?fields=.*replies/);
  await assert.rejects(api.publicReply("bad", "x").catch((e) => { assert.equal(e.kind, "auth"); throw e; }), /nope/);
});
