// Dated reminders the watcher sends to the team on WhatsApp from Zoey's number (the user, 22 Nov 2026:
// "make sure that I get reminded, or Zoey reminds us"). Each goes once a day at 10:00am Singapore time
// while it applies. There is no database: a reminder stops when its date in wrangler.toml is moved on.

const DAY = 24 * 3600;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The reminders due in this pass (unix seconds, the scheduled minute). Empty except at 10:00am Singapore time. */
export function reminders(now, env) {
  const sg = new Date((now + 8 * 3600) * 1000);
  if (sg.getUTCHours() !== 10 || sg.getUTCMinutes() !== 0) return [];
  const out = [];

  // Echo's Instagram token lasts about 60 days. From 10 days before it runs out, and every day after.
  const expires = Date.parse(`${env.IG_TOKEN_EXPIRES}T23:59:59+08:00`);
  if (Number.isFinite(expires)) {
    const days = Math.ceil((expires / 1000 - now) / DAY);
    if (days <= 10) {
      const d = new Date(expires + 8 * 3600 * 1000);
      const when = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
      out.push([
        days > 0 ? `Reminder: Echo's Instagram access runs out in ${days} day${days === 1 ? "" : "s"} (${when}).` : `Echo's Instagram access ran out on ${when}.`,
        days > 0 ? "When it does, TRIAL comments on Instagram stop getting replies." : "TRIAL comments on Instagram are not getting replies.",
        "To renew: in the Reverse Marketing app on Meta, open Instagram > API setup and generate a new token. Save it in GitHub as the IG_ACCESS_TOKEN secret of the reverse-echo repo, then tell Claude it's done so the new date gets set.",
      ].join("\n\n"));
    }
  }
  return out;
}

/** Sends each due reminder to every conversation listed; a closed WhatsApp window leaves a private note instead. */
export async function sendReminders({ api, env, now, dryRun = false, log = console.log, warn = console.warn }) {
  const texts = reminders(now, env);
  const convs = String(env.REMINDER_CONVERSATIONS ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean);
  let sent = 0;
  for (const text of texts) {
    for (const cid of convs) {
      if (dryRun) { log(`[dry run] would send a reminder to conversation ${cid}`); continue; }
      try { await api.send(cid, text); sent++; log(`REMINDER sent to conversation ${cid}`); }
      catch (err) {
        await api.note(cid, `Not sent (WhatsApp window closed):\n\n${text}`).catch(() => {});
        warn(`warning: reminder not delivered to conversation ${cid}: ${err.message}`);
      }
    }
  }
  return sent;
}
