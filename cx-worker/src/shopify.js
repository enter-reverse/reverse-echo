// When Shopify says an order was paid, find that buyer's chats in Chatwoot and label them "paid",
// so the follow-up never nudges someone who has already bought.

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/** True when the request really came from Shopify: its HMAC header matches the body signed with our secret. */
export async function verify(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  if (want.length !== hmacHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  return diff === 0;
}

const digits = (s) => String(s ?? "").replace(/\D/g, "");

/** The phone numbers (last 8 digits, as Singapore numbers are written) and emails on an order. */
export function buyerKeys(order) {
  const phones = [order?.phone, order?.customer?.phone, order?.billing_address?.phone, order?.shipping_address?.phone, order?.customer?.default_address?.phone]
    .map(digits).filter((d) => d.length >= 8).map((d) => d.slice(-8));
  const emails = [order?.email, order?.contact_email, order?.customer?.email].map((e) => String(e ?? "").trim().toLowerCase()).filter((e) => e.includes("@"));
  return { phones: [...new Set(phones)], emails: [...new Set(emails)] };
}

/** Labels every conversation of every Chatwoot contact that matches the order's phone or email. */
export async function markPaid({ api, order, dryRun = false, log = console.log }) {
  const { phones, emails } = buyerKeys(order);
  const result = { matchedContacts: 0, labelled: 0 };
  const seen = new Set();
  for (const key of [...phones, ...emails].slice(0, 4)) {
    const isPhone = !key.includes("@");
    for (const contact of (await api.searchContacts(key)).slice(0, 5)) {
      // Search is fuzzy; only accept an exact email, or a phone ending in the same 8 digits.
      const exact = isPhone ? digits(contact.phone_number).endsWith(key) : String(contact.email ?? "").toLowerCase() === key;
      if (!exact || seen.has(contact.id)) continue;
      seen.add(contact.id);
      result.matchedContacts++;
      for (const conv of (await api.contactConversations(contact.id)).slice(0, 10)) {
        if ((conv.labels ?? []).includes("paid")) continue;
        if (!dryRun) await api.addLabels(conv.id, ["paid"]);
        result.labelled++;
      }
    }
  }
  log(`${dryRun ? "[dry run] " : ""}Shopify order paid: ${result.matchedContacts} matching contact(s), ${result.labelled} conversation(s) labelled paid`);
  return result;
}
