// The auto-reply wording and the rules for when it applies.
// Ported line for line from cx-watch/autoreply.py (the watcher that ran in the CX chat);
// test/golden.json holds that script's own output and the tests compare against it.

// Chatwoot inbox ids.
export const INBOX = { instagram: 156618, waJooChiat: 157353, waCx: 156990, messenger: 156616, email: 156786, web: 156615 };
// Website claims arrive through the site's WhatsApp button; since 22 Nov 2026 the same claim text also starts
// Instagram DMs from ads that open a chat (the user: "fix for instagram too"). Follow-ups stay WhatsApp-only here.
const CLAIM_INBOXES = new Set([INBOX.waCx, INBOX.waJooChiat, INBOX.instagram]);

const TAIL =
  "- $199 for your first month, then $299 a month\n" +
  "- 10 credits a month from month 4, same price\n\n" +
  "Any questions, just ask me here :)\n\n- Zoey";

/** "jenny tan" -> "Jenny"; anything that isn't a plain 2+ letter name -> "" (then the reply opens without a name). */
// Romanised Chinese syllables (Hokkien, Cantonese, Teochew, Hakka, Pinyin) common in Singapore given names and surnames.
// Many Chinese given names are two such words ("Joo Leong", "Jia Xuan", "Wan Qing"): the user, 22 Nov 2026,
// "some chinese names is like 2 words", so both are used. "Rohan Raj" still gives "Rohan".
const CN = new Set(("ah ai an ang joo yeoh yik yew yeo koh goh teo tay toh seah lau khoo sim low lee wong au bao bee beng bin bing boon bun cai chai chan chang chao chee chek chen cheng cheong cheow chew chi chia chiam " +
  "chian chiang chien chih chin ching chio chiong chiu choe choi chong choo chooi chou chu chua chuan chun chung " +
  "da dai de dong en eng fa fang fei feng fong foo fu gan gao geok guan gui guo hai han hao he heng hian hin ho hock " +
  "hoe hong hoon hor hou hsin hu hua huan huang hui hun hwa hwee jia jian jiang jie jin jing jun kai kang kar keat kee " +
  "keng kew khai khee khim kian kiat kim kin king kit kok kong kuan kuang kum kun kwan kwang kwee lai lam lan lay le leng " +
  "leong li lian liang lie lien lih lim lin ling liu loh long loo lu luo ma mei meng mew miao min ming mui mun na nam nan " +
  "neo ng ning oh ong pang pei peng phua pin ping poh puay qi qian qiang qin qing qiu rong ru rui san seng shan shao sheng " +
  "shi shu shuang si siang sin sing siong siew siok soh song soo su sui sun swee tai tan tang teck tee teng tian tiong " +
  "toh tong tse wah wai wan wang wee wei wen weng wing wu xi xian xiang xiao xin xing xiu xu xuan ya yan yang yao ye yee " +
  "yi yin ying yong you yu yuan yue yun zhang zhao zhe zhen zheng zhi zhong zhou zhu zi").split(" "));
const SURNAMES = new Set("tan lim lee ng ong wong goh chua chan koh teo ang yeo yeoh tay ho low toh sim chong chia seah lau khoo heng neo".split(" "));
const cap = (w) => (w === w.toLowerCase() && /[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w);

export function firstName(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const w = words[0] ?? "";
  if (!/^[A-Za-z][A-Za-z'\-]{1,20}$/.test(w)) return "";
  const cn = (x) => CN.has(String(x).toLowerCase());
  // "Joo Leong" / "jia xuan": a two-word Chinese given name.
  if (words.length === 2 && words.every(cn)) return words.map(cap).join(" ");
  // "Tan Joo Leong": surname first, then a two-word given name.
  if (words.length === 3 && words.every(cn) && SURNAMES.has(words[0].toLowerCase())) return words.slice(1).map(cap).join(" ");
  return cap(w);
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
      // Same shape as every other therapy (the user, 22 Nov: standardise); the drop-in comes up only when they ask for one.
      return (
        inAt199 +
        "- 8 credits a month, enough for 4 Contrast sessions (75 minutes each, up to 4 people)\n" +
        "- Use your credits on any therapy at Reverse too: HBOT, Red Light and Dry Float\n" + TAIL
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
    case "red_info":
      // The "find out more" tap on the Red Light chat ad (the user, 22 Nov 2026): no name, a warm opener and one
      // question, so the CX manager can take it from their answer.
      return (
        // Introduces Zoey once, so no "- Zoey" sign-off; benefits stay general, no named results or figures
        // (the user, 22 Nov 6:08pm: "how come u introduce yourself 2 times ... just say general benefits"). Ends on the
        // question alone (the user, 22 Nov 8:25pm: "just ask the question, that's all").
        "Hey! I'm Zoey from Reverse. Our Redlight bed is full-body: you lie back for 20 minutes in your own private room. " +
        "Most people come for their skin or for recovery.\n\n" +
        "What are you looking to work on?"
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
  // The Red Light chat ad's two taps (22 Nov 2026). The person's tap says "Hi Reverse Team!" and our reply
  // introduces Zoey (the user: "just put Hi Reverse Team! then thats where we'll introduce ourself").
  if (/^(Hi Reverse Team!? )?I['’]d like to (find out|know) more about the red ?light experience( at Reverse)?!?$/i.test(t)) return "red_info";
  const tapClaim = t.match(/^Hi Reverse Team!? I['’]d like to claim my \$\d+ off (HBOT|Red ?Light|Contrast|Dry Float)\.?$/i);
  if (tapClaim) return THERAPY[Object.keys(THERAPY).find((k) => k.replace(" ", "").toLowerCase() === tapClaim[1].replace(" ", "").toLowerCase())];
  if (/^Hi Zoey! We'd like to claim our \$\d+ off HBOT for two/.test(t)) return "duo";
  const m = t.match(/^Hi Zoey! I'd like to claim my \$\d+ off (HBOT|Red Light|Contrast|Dry Float), \$\d+ for my first month\./);
  return m ? THERAPY[m[1]] : null;
}

/** One of the Instagram chat ad's taps ("Hi Reverse Team! I'd like to ..."). These are the only messages the
 * robot also answers in a chat we've written in before, so people who messaged Reverse in the past still get
 * the instant reply when they tap the ad (the user, 22 Nov 2026). */
export function isAdTap(text, inbox) {
  return inbox === INBOX.instagram && /^Hi Reverse Team!?\s/i.test(String(text ?? "").trim()) && kindOf(text, inbox) !== null;
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
    text: (n) => `Hi ${n}, last note from me about your $100 off, so I don't fill up your chat :)\n\nIt's still saved if you want it. Reply here any time and I'll send your link or answer any questions.`,
  },
};
