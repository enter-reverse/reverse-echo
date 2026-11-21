// Keyword matching for comments.
//
// A rule matches when one of its keywords appears in the comment as a whole
// word, whatever the case, punctuation or emoji around it:
//   "TRIAL"  "trial!!"  "Trial please 🙏"  "can I get the trial?"   -> match
//   "trials" "trialling" "entrial"                                   -> no match

/** Lowercase, strip accents, and turn everything that isn't a letter or digit into a space. */
export function normalise(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `keyword` (one or more words) appears in `text` on word boundaries. */
export function containsKeyword(text, keyword) {
  const haystack = ` ${normalise(text)} `;
  const needle = normalise(keyword);
  if (!needle) return false;
  return haystack.includes(` ${needle} `);
}

/** The first rule whose keywords match the comment, or null. Rules are checked in file order. */
export function matchRule(text, rules) {
  for (const rule of rules) {
    if (rule.keywords.some((k) => containsKeyword(text, k))) return rule;
  }
  return null;
}

/** Throws a readable error if rules.json is malformed, so a bad edit fails loudly before anything is sent. */
export function validateRules(config) {
  const rules = config?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('rules.json needs a non-empty "rules" list');
  }
  const seen = new Set();
  for (const [i, rule] of rules.entries()) {
    const where = `rules[${i}]${rule?.name ? ` ("${rule.name}")` : ""}`;
    if (!rule?.name) throw new Error(`${where}: missing "name"`);
    if (seen.has(rule.name)) throw new Error(`${where}: duplicate name`);
    seen.add(rule.name);
    if (!Array.isArray(rule.keywords) || rule.keywords.length === 0 || rule.keywords.some((k) => !normalise(k))) {
      throw new Error(`${where}: "keywords" must be a non-empty list of words`);
    }
    if (typeof rule.dm !== "string" || !rule.dm.trim()) throw new Error(`${where}: missing "dm" text`);
    if (rule.dm.length > 1000) throw new Error(`${where}: "dm" is ${rule.dm.length} characters; Instagram's limit is 1000`);
    if (!Array.isArray(rule.publicReplies) || rule.publicReplies.length === 0 || rule.publicReplies.some((r) => !String(r).trim())) {
      throw new Error(`${where}: "publicReplies" must be a non-empty list`);
    }
    if (typeof rule.fallbackReply !== "string" || !rule.fallbackReply.trim()) {
      throw new Error(`${where}: missing "fallbackReply"`);
    }
  }
  return rules;
}
