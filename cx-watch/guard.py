"""Outgoing-message guard (the user, 22 Nov 13:38: "make sure there are actual guardrails", without
inhibiting normal replies too much).

check(cid, text) returns a list of reasons the message must NOT go to a customer; empty means fine.
It is code, so it holds even if Claude is talked into something by a customer's message. It blocks:
- a phone number, other than the recipient's own
- an email address, other than hello@enterreverse.com or the recipient's own
- a link outside the allowlist (our sites, the booking app, maps)
- another customer's full name (from Chatwoot contacts)
- an order number (#1234)
Team chats (the user's and Andre's WhatsApp with the CX number) are exempt: they may carry personal details.
"""
import json, os, re, time

HERE = os.path.dirname(os.path.abspath(__file__))
TEAM_CHATS = {410, 158, 94, 433}  # Elijah (410) and Andre (94 on the CX number, 158 on Joo Chiat): may carry personal details
ALLOWED_LINKS = (
    r"https?://(www\.|pass\.|membership\.)?enterreverse\.com(/\S*)?",
    r"https?://apps\.apple\.com/sg/app/reverse-booking-app/id6758611918\S*",
    r"https?://play\.google\.com/store/apps/details\?id=com\.fitnessmobileapps\.reverse43913\S*",
    r"https?://(www\.)?google\.com/maps\S*", r"https?://maps\.app\.goo\.gl/\S*",
    r"https?://(www\.)?instagram\.com/enter\.reverse\S*",
    # drop-in checkouts (the user, 22 Nov 14:41): Contrast, Dry Float, Red Light, HBOT
    r"https?://enterreverse\.myshopify\.com/cart/(44774708150314|44011557322794|44011558043690|44011557716010):1\?checkout",
)
ALLOWED_EMAILS = {"hello@enterreverse.com"}
CACHE = os.path.join(HERE, "names_cache.json")


def _norm_phone(s):
    d = re.sub(r"\D", "", s or "")
    return d[-8:] if len(d) >= 8 else d


def _names(req):
    """Full names (2+ words) of Chatwoot contacts, cached for 6 hours."""
    try:
        c = json.load(open(CACHE))
        if time.time() - c["at"] < 6 * 3600:
            return c["names"]
    except Exception:
        pass
    names = set()
    for page in range(1, 11):
        try:
            rows = req(f"/contacts?page={page}&sort=-last_activity_at")["payload"]
        except Exception:
            break
        if not rows:
            break
        for r in rows:
            n = re.sub(r"\s+", " ", (r.get("name") or "").strip())
            if len(n.split(" ")) >= 2 and re.fullmatch(r"[A-Za-z][A-Za-z .'\-]{3,40}", n):
                names.add(n.lower())
    json.dump({"at": time.time(), "names": sorted(names)}, open(CACHE, "w"))
    return sorted(names)


def check(cid, text, req):
    if int(cid) in TEAM_CHATS:
        return []
    reasons = []
    conv = {}
    try:
        conv = req(f"/conversations/{cid}")
        me = conv.get("meta", {}).get("sender", {}) or {}
    except Exception:
        me = {}
    my_phone = _norm_phone(me.get("phone_number"))
    my_email = (me.get("email") or "").lower()
    my_name = (me.get("name") or "").lower()

    body = text
    for pat in ALLOWED_LINKS:
        body = re.sub(pat, " ", body, flags=re.I)
    links = re.findall(r"https?://\S+|www\.\S+", body, flags=re.I)
    if links:
        reasons.append(f"link not on the allowlist: {links[0][:60]}")

    for e in re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", body):
        if e.lower() not in ALLOWED_EMAILS and e.lower() != my_email:
            reasons.append(f"email address: {e}")

    for p in re.findall(r"\+?\d[\d \-]{6,}\d", body):
        digits = re.sub(r"\D", "", p)
        if len(digits) >= 8 and _norm_phone(p) != my_phone:
            reasons.append(f"phone-like number: {p.strip()}")

    # "- Zoey" goes on the first message of a WhatsApp or Messenger chat only. Never on Instagram, where Echo's
    # TRIAL DM (sent straight through Instagram, so invisible here) has usually signed already; never once we've
    # written in the chat (the user, 22 Nov 8:16pm: "make sure the dash Zoey doesn't [double] ... how many times").
    if re.search(r"(^|\n)\s*-\s*Zoey\s*$", text.strip(), flags=re.I):
        inbox = (conv or {}).get("inbox_id")
        try:
            ours = [m for m in req(f"/conversations/{cid}/messages")["payload"] if m.get("message_type") == 1 and not m.get("private")]
        except Exception:
            ours = [1]
        if inbox == 156618:
            reasons.append('"- Zoey" sign-off on Instagram (Echo has usually signed already): remove it')
        elif ours:
            reasons.append('"- Zoey" sign-off, but we have already written in this chat: remove it')

    if re.search(r"#\d{3,}", body):
        reasons.append("order number")

    low = " " + re.sub(r"\s+", " ", body.lower()) + " "
    for n in _names(req):
        if n and n not in my_name and my_name not in n and re.search(r"(?<![a-z])" + re.escape(n) + r"(?![a-z])", low):
            reasons.append(f"another customer's name: {n.title()}")
            break
    return reasons
