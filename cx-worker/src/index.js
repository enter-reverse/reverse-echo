// The hosted CX watcher as a Cloudflare Worker. Cloudflare starts `scheduled` every minute.

import { createChatwoot } from "./chatwoot.js";
import { tick } from "./cx.js";
import { markPaid, verify } from "./shopify.js";
import { countPass } from "./passes.js";

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
      // Days 3 and 5 are Meta-approved templates, each with its own switch; checked every 10 minutes, off the day-1 minute.
      templates: Math.floor(now / 60) % 10 === 5
        ? { day3: env.FOLLOWUP_DAY3 === "on", day5: env.FOLLOWUP_DAY5 === "on", language: env.TEMPLATE_LANGUAGE }
        : {},
      // Alerts go to the owner's own WhatsApp chat with the CX line (a Chatwoot conversation id).
      alerts: env.ALERTS === "on" && Number(env.ALERT_CONVERSATION) ? { conversation: Number(env.ALERT_CONVERSATION), account: env.CW_ACC } : null,
      now,
    },
  });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          // The scheduled minute, not the clock: back-to-back passes then never overlap or leave a gap.
          const now = Math.floor((event?.scheduledTime ?? Date.now()) / 1000);
          const { errors, ...counts } = await run(env, { now });
          // One line per pass, so the log shows the watcher is alive and reaching Chatwoot.
          console.log(JSON.stringify({ dryRun: !(env.DRY_RUN === "0" || env.DRY_RUN === "false"), ...counts }));
          for (const e of errors) console.warn(`warning: ${e}`);
        } catch (err) {
          console.error(`run failed: ${err.message}`);
        }
      })(),
    );
  },
  // The only thing served: Shopify's "order paid" notification, at /shopify.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/shopify") {
      return new Response("CX watcher is running.\n", { headers: { "content-type": "text/plain" } });
    }
    if (!env.SHOPIFY_WEBHOOK_SECRET) return new Response("not configured", { status: 503 });
    const raw = await request.text();
    if (!(await verify(raw, request.headers.get("X-Shopify-Hmac-Sha256"), env.SHOPIFY_WEBHOOK_SECRET))) {
      return new Response("bad signature", { status: 401 });
    }
    let order;
    try { order = JSON.parse(raw); } catch { return new Response("bad body", { status: 400 }); }
    const api = createChatwoot({ token: env.CW_TOKEN, account: env.CW_ACC });
    const dryRun = !(env.DRY_RUN === "0" || env.DRY_RUN === "false");
    // Answer Shopify straight away (it retries anything slower than 5 seconds) and finish the labelling after.
    ctx.waitUntil(markPaid({ api, order, dryRun }).catch((err) => console.error(`Shopify paid label failed: ${err.message}`)));
    // The pass counter: WhatsApp the user the new total and the buyer's journey (off until PASS_ALERT_CONV is set).
    ctx.waitUntil(countPass({ api, order, env, dryRun }).catch((err) => console.error(`pass counter failed: ${err.message}`)));
    return new Response("ok");
  },
};
