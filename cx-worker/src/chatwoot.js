// The few Chatwoot calls the watcher needs.

export class ChatwootError extends Error {
  constructor(message, status) { super(message); this.name = "ChatwootError"; this.status = status; }
}

export function createChatwoot({ token, account, host = "https://app.chatwoot.com", fetchImpl = fetch }) {
  if (!token || !account) throw new Error("CW_TOKEN / CW_ACC are not set");
  const base = `${host}/api/v1/accounts/${account}`;

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { api_access_token: token, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ChatwootError(`network error: ${err.message}`, 0);
    }
    if (!res.ok) throw new ChatwootError(`Chatwoot ${method} ${path.split("?")[0]} -> HTTP ${res.status}`, res.status);
    return res.json();
  }

  const publicOnly = (payload) => (payload ?? []).filter((m) => (m.message_type === 0 || m.message_type === 1) && !m.private);

  return {
    /** First page (the 25 most recently active) of conversations in a status. */
    async conversations(status) {
      return (await call("GET", `/conversations?status=${status}&assignee_type=all&page=1`)).data?.payload ?? [];
    },
    /** Conversations carrying a label, any status. */
    async labelled(label) {
      return (await call("GET", `/conversations?status=all&assignee_type=all&labels[]=${encodeURIComponent(label)}&page=1`)).data?.payload ?? [];
    },
    /** The latest public messages of a conversation, oldest first: 0 = from the customer, 1 = from us. */
    async messages(cid) {
      return publicOnly((await call("GET", `/conversations/${cid}/messages`)).payload).sort((a, b) => a.created_at - b.created_at);
    },
    send: (cid, content) => call("POST", `/conversations/${cid}/messages`, { content, message_type: "outgoing", private: false }),
    /** Adds labels, keeping the ones already there. */
    async addLabels(cid, labels) {
      const have = (await call("GET", `/conversations/${cid}/labels`)).payload ?? [];
      const all = [...new Set([...have, ...labels])];
      if (all.length !== have.length) await call("POST", `/conversations/${cid}/labels`, { labels: all });
    },
  };
}
