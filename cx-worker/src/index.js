// The hosted CX watcher as a Cloudflare Worker. Cloudflare starts `scheduled` every minute.

import { createChatwoot } from "./chatwoot.js";
import { tick } from "./cx.js";

export async function run(env, { fetchImpl = fetch, log = console.log, now = Math.floor(Date.now() / 1000) } = {}) {
  const api = createChatwoot({ token: env.CW_TOKEN, account: env.CW_ACC, fetchImpl });
  return tick({
    api,
    log,
    options: {
      // Anything other than an explicit "0"/"false" is a dry run, so a missing setting can never send.
      dryRun: !(env.DRY_RUN === "0" || env.DRY_RUN === "false"),
      // Follow-ups are checked every 10 minutes, and only when switched on.
      followups: env.FOLLOWUPS === "on" && Math.floor(now / 60) % 10 === 0,
      now,
    },
  });
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const { errors, ...counts } = await run(env);
          if (counts.autoSent || counts.followupsSent || counts.skipped || errors.length) console.log(JSON.stringify(counts));
          for (const e of errors) console.warn(`warning: ${e}`);
        } catch (err) {
          console.error(`run failed: ${err.message}`);
        }
      })(),
    );
  },
  async fetch() {
    return new Response("CX watcher is running.\n", { headers: { "content-type": "text/plain" } });
  },
};
