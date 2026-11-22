import { test } from "node:test";
import assert from "node:assert/strict";
import { reminders, sendReminders } from "../src/reminders.js";

const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const env = { IG_TOKEN_EXPIRES: "2027-01-20", REMINDER_CONVERSATIONS: "410,94" };

test("the Instagram token reminder starts 10 days before, once a day at 10am Singapore time", () => {
  assert.deepEqual(reminders(at("2027-01-09T10:00:00+08:00"), env), [], "12 days out");
  assert.deepEqual(reminders(at("2027-01-11T09:59:00+08:00"), env), [], "not 10am");
  assert.deepEqual(reminders(at("2027-01-11T10:01:00+08:00"), env), [], "not 10am");
  const r = reminders(at("2027-01-11T10:00:00+08:00"), env);
  assert.equal(r.length, 1);
  assert.ok(r[0].startsWith("Reminder: Echo's Instagram access runs out in 10 days (20 Jan)."));
  assert.ok(reminders(at("2027-01-20T10:00:00+08:00"), env)[0].includes("in 1 day (20 Jan)"));
  assert.ok(reminders(at("2027-01-22T10:00:00+08:00"), env)[0].startsWith("Echo's Instagram access ran out on 20 Jan."));
  assert.deepEqual(reminders(at("2027-01-11T10:00:00+08:00"), {}), [], "no date set");
});

test("reminders go to everyone listed; a closed window leaves a note and a warning", async () => {
  const sent = [], notes = [], warns = [];
  const api = { send: async (cid, t) => { if (cid === 94) throw new Error("HTTP 422"); sent.push([cid, t]); }, note: async (cid, t) => notes.push([cid, t]) };
  const n = await sendReminders({ api, env, now: at("2027-01-15T10:00:00+08:00"), log: () => {}, warn: (w) => warns.push(w) });
  assert.equal(n, 1);
  assert.deepEqual(sent.map((x) => x[0]), [410]);
  assert.deepEqual(notes.map((x) => x[0]), [94]);
  assert.match(warns[0], /reminder not delivered to conversation 94/);
  assert.equal(await sendReminders({ api, env, now: at("2027-01-15T10:00:00+08:00"), dryRun: true, log: () => {} }), 0);
});
