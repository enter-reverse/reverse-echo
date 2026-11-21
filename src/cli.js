#!/usr/bin/env node
// Runs one pass. Settings come from the environment:
//
//   IG_ACCESS_TOKEN   (required) long-lived Instagram User access token for the account
//   DRY_RUN=1         log what would be sent, send nothing
//   IGNORE_BEFORE     ISO time; comments older than this are never answered (set to go-live time)
//   HISTORY_CHECK=0   skip reading the DM thread before sending (not recommended)
//   MEDIA_LIMIT       how many recent posts to check (default 25)
//   MAX_ACTIONS       cap on comments answered per run (default 40)
//   IG_API_VERSION    default v25.0

import { readFile } from "node:fs/promises";
import { createClient } from "./instagram.js";
import { validateRules } from "./match.js";
import { runOnce } from "./engine.js";

const env = process.env;
const rulesPath = new URL("../rules.json", import.meta.url);

try {
  const rules = validateRules(JSON.parse(await readFile(rulesPath, "utf8")));

  if (process.argv.includes("--check")) {
    console.log(`rules.json is valid: ${rules.map((r) => `${r.name} [${r.keywords.join(", ")}]`).join("; ")}`);
    if (process.argv.includes("--links")) {
      // Open every link in every DM, so a dead or mistyped link is caught before customers get it.
      let bad = 0;
      for (const rule of rules) {
        for (const url of rule.dm.match(/https?:\/\/[^\s]+/g) ?? []) {
          try {
            const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (reverse-echo link check)" } });
            const landed = new URL(res.url);
            const where = `${landed.host}${landed.pathname.split("/").slice(0, 3).join("/")}`; // no query: it can hold session tokens
            // 401/403/429 mean the site answered but won't show the page to a script (e.g. Shopify checkout). Not a dead link.
            const blocked = [401, 403, 429].includes(res.status);
            const dead = !res.ok && !blocked;
            console.log(`link ${url} -> HTTP ${res.status}, lands on ${where}${blocked ? " (reached, but the page is hidden from scripts; open it by hand to check the offer)" : ""}`);
            if (dead) bad++;
          } catch (err) {
            console.log(`link ${url} -> FAILED: ${err.message}`);
            bad++;
          }
        }
      }
      if (bad) { console.error(`${bad} link(s) in rules.json did not load`); process.exit(1); }
    }
    process.exit(0);
  }

  let ignoreBefore = null;
  if (env.IGNORE_BEFORE) {
    ignoreBefore = new Date(env.IGNORE_BEFORE);
    if (Number.isNaN(ignoreBefore.getTime())) throw new Error(`IGNORE_BEFORE is not a date: ${env.IGNORE_BEFORE}`);
  }

  const api = createClient({ token: env.IG_ACCESS_TOKEN, version: env.IG_API_VERSION || "v25.0" });
  const summary = await runOnce({
    api,
    rules,
    options: {
      dryRun: env.DRY_RUN === "1" || env.DRY_RUN === "true",
      mediaLimit: Number(env.MEDIA_LIMIT) || 25,
      maxActions: Number(env.MAX_ACTIONS) || 40,
      ignoreBefore,
      historyCheck: !(env.HISTORY_CHECK === "0" || env.HISTORY_CHECK === "false"),
    },
  });

  const { errors, ...counts } = summary;
  console.log(JSON.stringify(counts));
  for (const e of errors) console.error(`warning: ${e}`);
} catch (err) {
  if (err.kind === "auth") {
    console.error(`Instagram rejected the access token (${err.message}). Generate a new one and update IG_ACCESS_TOKEN.`);
  } else {
    console.error(`run failed: ${err.message}`);
  }
  process.exit(1);
}
