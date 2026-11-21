// Echo as a Cloudflare Worker. Cloudflare starts `scheduled` every minute; each
// start is one ordinary Echo pass (see src/engine.js), the same one the GitHub
// workflow runs.

import rulesConfig from "../../rules.json" with { type: "json" };
import { createClient } from "../../src/instagram.js";
import { validateRules } from "../../src/match.js";
import { runOnce } from "../../src/engine.js";

const flag = (v) => v === "1" || v === "true";
const num = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);

/** One pass. Returns the summary so it can be logged and tested. */
export async function pass(env, { fetchImpl = fetch, log = console.log, now = new Date() } = {}) {
  const rules = validateRules(rulesConfig);
  const api = createClient({ token: env.IG_ACCESS_TOKEN, version: env.IG_API_VERSION || "v25.0", fetchImpl });
  return runOnce({
    api,
    rules,
    log,
    options: {
      // Anything other than an explicit "0"/"false" is a dry run, so a missing setting can never send.
      dryRun: !(env.DRY_RUN === "0" || env.DRY_RUN === "false"),
      diagnose: flag(env.DIAGNOSE),
      mediaLimit: num(env.MEDIA_LIMIT, 20),
      maxLookups: num(env.MAX_LOOKUPS, 6),
      maxActions: num(env.MAX_ACTIONS, 5),
      ignoreBefore: env.IGNORE_BEFORE ? new Date(env.IGNORE_BEFORE) : null,
      now,
    },
  });
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const { errors, ...counts } = await pass(env);
          console.log(JSON.stringify(counts));
          for (const e of errors) console.warn(`warning: ${e}`);
        } catch (err) {
          // Shows in the Worker's logs; the next minute tries again.
          console.error(err.kind === "auth" ? `Instagram rejected the access token: ${err.message}` : `run failed: ${err.message}`);
        }
      })(),
    );
  },

  // Nothing is served publicly; this only answers "is it deployed?".
  async fetch() {
    return new Response("Echo is running.\n", { headers: { "content-type": "text/plain" } });
  },
};
