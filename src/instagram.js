// A thin client for the Instagram API (Instagram Login flavour, graph.instagram.com).
// Only the four calls Echo needs: who am I, recent media, comments on a media,
// private reply (DM) to a comment, public reply to a comment.

export class InstagramError extends Error {
  constructor(message, { status, code, subcode, kind }) {
    super(message);
    this.name = "InstagramError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    /** "auth" (token is bad: stop the run), "transient" (try again next run), or "permanent" (this action won't ever work). */
    this.kind = kind;
  }
}

// Graph API codes that mean "not now": unknown/service errors and the rate-limit family.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80002, 80006]);

export function classify(status, code) {
  if (code === 190 || status === 401) return "auth";
  if (status >= 500 || status === 429 || TRANSIENT_CODES.has(code)) return "transient";
  return "permanent";
}

export function createClient({ token, version = "v25.0", host = "https://graph.instagram.com", fetchImpl = fetch }) {
  if (!token) throw new Error("IG_ACCESS_TOKEN is not set");
  const base = `${host}/${version}`;

  async function call(method, path, { query, body } = {}) {
    const url = path.startsWith("http") ? new URL(path) : new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new InstagramError(`network error: ${err.message}`, { status: 0, kind: "transient" });
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok || json?.error) {
      const e = json?.error ?? {};
      throw new InstagramError(e.message ?? `HTTP ${res.status}`, {
        status: res.status,
        code: e.code,
        subcode: e.error_subcode,
        kind: classify(res.status, e.code),
      });
    }
    return json;
  }

  return {
    /** The connected account: { id, user_id, username }. */
    me: () => call("GET", "me", { query: { fields: "id,user_id,username" } }),

    /** The account's most recent posts and reels, newest first. */
    async recentMedia(limit) {
      const page = await call("GET", "me/media", {
        query: { fields: "id,timestamp,comments_count,permalink", limit: String(limit) },
      });
      return page.data ?? [];
    },

    /** Top-level comments on a media, each with the replies under it. Follows paging up to maxPages. */
    async comments(mediaId, { maxPages = 5 } = {}) {
      const out = [];
      const get = (fields) => call("GET", `${mediaId}/comments`, { query: { fields, limit: "50" } });
      let page;
      try {
        page = await get("id,text,timestamp,username,from,replies{id,username,from,timestamp}");
      } catch (err) {
        if (err.kind !== "permanent") throw err;
        // Some accounts reject `from`; fall back to usernames only.
        page = await get("id,text,timestamp,username,replies{id,username,timestamp}");
      }
      for (let i = 0; ; i++) {
        out.push(...(page.data ?? []));
        const next = page.paging?.next;
        if (!next || i + 1 >= maxPages) break;
        page = await call("GET", next);
      }
      return out;
    },

    /** The replies under one comment, with who wrote each. (The nested list on `comments` comes back without authors.) */
    async replies(commentId) {
      const page = await call("GET", `${commentId}/replies`, {
        query: { fields: "id,text,timestamp,username,from", limit: "50" },
      });
      return page.data ?? [];
    },

    /**
     * The most recent DMs (up to 20) between the account and one person, by their
     * Instagram-scoped id: [{ from: { id, username }, message, created_time }].
     * An empty list means there is no conversation with them.
     */
    async messagesWith(userId) {
      const found = await call("GET", "me/conversations", { query: { user_id: String(userId) } });
      const conversation = found.data?.[0];
      if (!conversation) return [];
      const detail = await call("GET", conversation.id, {
        query: { fields: "messages.limit(20){id,created_time,from,message}" },
      });
      const list = (detail.messages?.data ?? []).slice(0, 20);
      // If the API returned bare ids, fetch each message's details.
      if (list.length && list.every((m) => m.message === undefined && m.from === undefined)) {
        const out = [];
        for (const m of list) {
          try {
            out.push(await call("GET", m.id, { query: { fields: "id,created_time,from,message" } }));
          } catch (err) {
            if (err.kind !== "permanent") throw err; // older than the 20 Instagram lets us read
          }
        }
        return out;
      }
      return list;
    },

    /** DM the person who wrote a comment. Instagram allows one per comment, within 7 days of it. */
    privateReply: (commentId, text) =>
      call("POST", "me/messages", { body: { recipient: { comment_id: commentId }, message: { text } } }),

    /** Reply publicly under a comment. */
    publicReply: (commentId, text) => call("POST", `${commentId}/replies`, { body: { message: text } }),
  };
}
