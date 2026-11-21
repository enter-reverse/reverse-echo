// The auto-reply wording and the rules for when it applies.
// Ported line for line from cx-watch/autoreply.py (the watcher that ran in the CX chat);
// test/golden.json holds that script's own output and the tests compare against it.

// Chatwoot inbox ids.
export const INBOX = { instagram: 156618, waJooChiat: 157353, waCx: 156990, messenger: 156616, email: 156786, web: 156615 };
// Website claims arrive through the site's WhatsApp button.
const CLAIM_INBOXES = new Set([INBOX.waCx, INBOX.waJooChiat]);

const TAIL =
  "- $199 for your first month, then $299 a month\n" +
  "- 10 credits a month from month 4, same price\n\n" +
  "Any questions, just ask me here :)\n\n- Zoey";

/** "jenny tan" -> "Jenny"; anything that isn't a plain 2+ letter name -> "" (then the reply opens without a name). */
export function firstName(name) {
  const w = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z][A-Za-z'\-]{1,20}$/.test(w)) return "";
  const isLower = w === w.toLowerCase() && /[a-z]/.test(w);
  return isLower ? w[0].toUpperCase() + w.slice(1) : w;
}

export function tpl(kind, name) {
  const hey = name ? `Hey ${name}!` : "Hey!";
  const hi = name ? `Hi ${name}` : "Hi";
  const gift = "https://pass.enterreverse.com/gift";
  const inAt199 = `${hi}, you're in! Here's your $199 first month, with your $100 off already applied:\n\n${gift}\n\nWhat you get:\n`;
  switch (kind) {
    case "trial":
      return (
        `${hey} Your trial pass is here: your first month is $199 instead of $299, with the $100 off already applied.\n\n` +
        `${gift}\n\n` +
        "That's 8 credits to use across HBOT, Red Light, Contrast and Dry Float, then $299 a month after, no commitment. " +
        "Any questions, just ask me here :)\n\n- Zoey"
      );
    case "hbot":
      return (
        inAt199 +
        "- 8 credits a month, enough for 4 HBOT sessions at 2.0 ATA (55 minutes each)\n" +
        "- Use your credits on any therapy at Reverse too: Red Light, Dry Float and Contrast\n" + TAIL
      );
    case "red":
      return (
        inAt199 +
        "- 8 credits a month, enough for 8 Red Light sessions\n" +
        "- Use your credits on any therapy at Reverse too: HBOT, Dry Float and Contrast\n" + TAIL
      );
    case "float":
      return (
        inAt199 +
        "- 8 credits a month, enough for 8 Dry Float sessions (50 minutes each)\n" +
        "- Use your credits on any therapy at Reverse too: HBOT, Red Light and Contrast\n" + TAIL
      );
    case "contrast":
      return (
        `${hey} Your $100 off is locked in. It takes $100 off your first month of the monthly pass, so it's $199 instead of $299.\n\n` +
        "You can also start smaller with a drop-in: one Contrast night at our member rate, $75 for 75 minutes.\n\n" +
        "If you like it, it's $124 more and we top it up into your first month: 3 more Contrast nights (or mix: say 2 Contrast and 2 Red Light), and your $75 already counts. No need to buy a new pass on top.\n\n- Zoey"
      );
    case "duo":
      return (
        `${hi}, you're both in! Here's your $299 first month for two, with your $299 off already applied:\n\n` +
        "https://pass.enterreverse.com/gift-duo\n\nWhat you get:\n" +
        "- 16 credits a month between you (8 each), enough for 4 HBOT sessions each at 2.0 ATA (55 minutes)\n" +
        "- Use your credits on any therapy at Reverse too: Red Light, Dry Float and Contrast\n" +
        "- $299 for your first month together, then $598 a month\n" +
        "- 10 credits each a month from month 4, same price\n\n" +
        "Any questions, just ask me here :)\n\n- Zoey"
      );
    default:
      return null;
  }
}

const THERAPY = { HBOT: "hbot", "Red Light": "red", Contrast: "contrast", "Dry Float": "float" };

/** Which auto-reply, if any, a customer message gets: "trial", a claim kind, or null. */
export function kindOf(text, inbox) {
  const t = String(text ?? "").trim();
  if (/^[^\p{L}\p{N}]*trial[^\p{L}\p{N}]*$/iu.test(t)) return "trial";
  if (!CLAIM_INBOXES.has(inbox)) return null;
  if (/^Hi Zoey! We'd like to claim our \$\d+ off HBOT for two/.test(t)) return "duo";
  const m = t.match(/^Hi Zoey! I'd like to claim my \$\d+ off (HBOT|Red Light|Contrast|Dry Float), \$\d+ for my first month\./);
  return m ? THERAPY[m[1]] : null;
}

/** The approved day-1 follow-up (the user, 21 Nov 2026). No sign-off: they've had our first message. */
export function followup1(name) {
  const body = "$100 off is still saved for you. Any questions about how it works, just ask me here :)";
  return name ? `Hi ${name}, your ${body}` : `Hi! Your ${body}`;
}
export const FOLLOWUP1_MARKER = "$100 off is still saved for you";

// Days 3 and 5 go out after WhatsApp's 24-hour window has closed, so they are Meta-approved templates
// (WhatsApp Manager > Message templates, on the CX number). The wording below is what was submitted
// (the user, 22 Nov 2026); Meta sends its own approved copy, this text is what Chatwoot shows in the chat.
// {{1}} is the first name. A template can't open without one, so nameless claimers are skipped.
export const TEMPLATES = {
  day3: {
    name: "claim_followup_day3",
    label: "fu3",
    text: (n) => `Hi ${n}, Zoey from Reverse here :)\n\nIf you'd rather see the space before deciding, come by for a tour. We're at 171 Joo Chiat Road, open 7am to 10pm.\n\nJust reply here with when you're coming and I'll let my team know to expect you!`,
  },
  day5: {
    name: "claim_followup_day5",
    label: "fu5",
    text: (n) => `Hi ${n}, last note from me about your $100 off, so I don't fill up your chat :)\n\nIt's still saved if you want it. Reply here any time and I'll send your link or answer anything.`,
  },
};
