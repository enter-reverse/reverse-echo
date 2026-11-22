// The hosted CX watcher as a Cloudflare Worker. Cloudflare starts `scheduled` every minute.

import { createChatwoot } from "./chatwoot.js";
import { tick } from "./cx.js";
import { markPaid, verify } from "./shopify.js";
import { sendReminders } from "./reminders.js";
import { countPass } from "./passes.js";
import { syncLeads } from "./leads.js";

/** "410, 94,433" -> [410, 94, 433]; blanks and non-numbers dropped. */
export const convList = (v) => String(v ?? "").split(",").map((x) => Number(x.trim())).filter((n) => n > 0);

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
      // The once-per-chat "You're welcome!" (off since 23 Nov: Cloudflare sends only the first message).
      thanks: env.THANK_YOU === "on",
      // Days 3 and 5 are Meta-approved templates, each with its own switch; checked every 10 minutes, off the day-1 minute.
      templates: Math.floor(now / 60) % 10 === 5
        ? { day3: env.FOLLOWUP_DAY3 === "on", day5: env.FOLLOWUP_DAY5 === "on", language: env.TEMPLATE_LANGUAGE }
        : {},
      // Alerts go to the owner's own WhatsApp chat with the CX line (a Chatwoot conversation id).
      // Several chats, comma-separated ("410,94,433": Elijah, Andre, Gordon); everyone gets the same alert (the user, 22 Nov).
      alerts: env.ALERTS === "on" && convList(env.ALERT_CONVERSATION).length
        ? { conversations: convList(env.ALERT_CONVERSATION), account: env.CW_ACC } : null,
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
          // Meta lead form leads into Loops, every 10 minutes (off until LEAD_FORMS, META_PAGE_TOKEN and LOOPS_API_KEY are set).
          if (Math.floor(now / 60) % 10 === 7 && env.LEAD_FORMS) {
            const l = await syncLeads({ env, now, dryRun: !(env.DRY_RUN === "0" || env.DRY_RUN === "false") });
            if (l.leads || l.errors.length) console.log(JSON.stringify({ leadForms: l }));
          }
          // Dated reminders to the team (10:00am Singapore time only).
          if (env.REMINDER_CONVERSATIONS) {
            await sendReminders({ api: createChatwoot({ token: env.CW_TOKEN, account: env.CW_ACC }), env, now, dryRun: !(env.DRY_RUN === "0" || env.DRY_RUN === "false") });
          }
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
