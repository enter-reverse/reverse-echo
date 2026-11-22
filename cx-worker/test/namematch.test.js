import { test } from "node:test";
import assert from "node:assert/strict";
import { markPaid, nameMatch } from "../src/shopify.js";

const NOW = 1_800_000_000;
function api({ contacts = {}, convs = {} }) {
  const labelled = [], notes = [];
  return {
    labelled, notes,
    searchContacts: async (q) => contacts[q] ?? [],
    contactConversations: async (id) => convs[id] ?? [],
    addLabels: async (id, l) => labelled.push([id, ...l]),
    note: async (id, t) => notes.push([id, t]),
  };
}
const order = (extra = {}) => ({ name: "#2635", email: "a.m@example.com", customer: { first_name: "Anna", last_name: "Tan" }, ...extra });
const claim = (id, ago = 3600, labels = ["claim"]) => ({ id, labels, last_activity_at: Math.floor(Date.now() / 1000) - ago });

test("an order with no phone or email match is labelled paid by the buyer's name, with a note", async () => {
  const a = api({ contacts: { anna: [{ id: 1, name: "Anna" }] }, convs: { 1: [claim(424)] } });
  const r = await markPaid({ api: a, order: order(), log: () => {} });
  assert.equal(r.byName, true);
  assert.deepEqual(a.labelled, [[424, "paid"]]);
  assert.match(a.notes[0][1], /#2635/);
});

test("no label when two claim chats share the name, or the chat is old, or it isn't a claim", async () => {
  let a = api({ contacts: { anna: [{ id: 1, name: "Anna" }, { id: 2, name: "anna tan" }] }, convs: { 1: [claim(424)], 2: [claim(425)] } });
  assert.equal(await nameMatch({ api: a, order: order() }), null);
  a = api({ contacts: { anna: [{ id: 1, name: "Anna" }] }, convs: { 1: [claim(424, 20 * 86400)] } });
  assert.equal(await nameMatch({ api: a, order: order() }), null);
  a = api({ contacts: { anna: [{ id: 1, name: "Anna" }] }, convs: { 1: [claim(424, 3600, ["lead"])] } });
  assert.equal(await nameMatch({ api: a, order: order() }), null);
  a = api({ contacts: { anna: [{ id: 1, name: "Annabelle" }] }, convs: { 1: [claim(424)] } });
  assert.equal(await nameMatch({ api: a, order: order() }), null);
});
