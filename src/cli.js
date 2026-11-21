#!/usr/bin/env node
// Runs one pass. Settings come from the environment:
//
//   IG_ACCESS_TOKEN   (required) long-lived Instagram User access token for the account
//   DRY_RUN=1         log what would be sent, send nothing
//   IGNORE_BEFORE     ISO time; comments older than this are never answered (set to go-live time)
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
