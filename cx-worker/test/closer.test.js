import { test } from "node:test";
import assert from "node:assert/strict";
import { isCloser } from "../src/cx.js";

test("sign-offs need no reply, so they never start the unanswered clock", () => {
  for (const s of ["Thank you! ☺️", "Appreciate it", "ok noted", "Thanks!", "👍", "ok thanks zoey", "Noted, thank you so much", "tq", "See you!"]) {
    assert.equal(isCloser(s), true, s);
  }
});

test("questions, requests and attachments still do", () => {
  for (const s of ["Thanks! What is HBOT?", "Thank you, can I book for 6pm", "ok but how do I claim", "?", "", "Hbot", "Hi I have checked out, how do I book"]) {
    assert.equal(isCloser(s), false, s);
  }
});

import { firstName } from "../src/templates.js";
test("two-word Chinese given names keep both words; other names give the first word", () => {
  assert.equal(firstName("Joo Leong"), "Joo Leong");
  assert.equal(firstName("jia xuan"), "Jia Xuan");
  assert.equal(firstName("Wan Qing"), "Wan Qing");
  assert.equal(firstName("Tan Joo Leong"), "Joo Leong");
  assert.equal(firstName("Rohan Raj"), "Rohan");
  assert.equal(firstName("Stacey"), "Stacey");
  assert.equal(firstName("Murni Samad"), "Murni");
  assert.equal(firstName("Yeoh Wan Qing"), "Wan Qing");
  assert.equal(firstName("bold-sun-48"), "");
});
