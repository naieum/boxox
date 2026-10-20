import { BoxOxError } from "./client.js";

export interface AgentPageOptions { limit?: number; cursor?: string }
export interface AgentBodyOptions extends AgentPageOptions { includeBody?: boolean }
export interface AgentWorkOptions { group?: string; leaseSeconds?: number }
export interface AgentWorkReference { messageId: string; claimToken: string; group?: string | null }
export interface AgentWorkReceipt { messageId: string; group: string | null; claimToken: string; leaseUntil: string; attempts: number }
export interface AgentThread {
  id: string; subject: string; snippet: string; folder: string; unread: boolean; messageCount: number;
  lastMessageAt: string; counterpartyEmail: string | null; counterpartyName: string | null; addressId: string | null;
}
export interface AgentMessage {
  id: string; direction: "inbound" | "outbound"; fromEmail: string; fromName: string | null;
  toEmails: string[]; ccEmails: string[]; subject: string; snippet: string; text: string | null; occurredAt: string;
  bodyTruncated: boolean; bodyUnavailable?: "too_large" | "missing" | "unreadable";
}
export interface AgentChange { cursor: string; kind: string; threadId: string; messageId: string | null; occurredAt: string }
export interface AgentPendingMessage { messageId: string; threadId: string; subject: string; snippet: string; occurredAt: string }
export interface AgentSendInput { fromAddressId: string; to: string[]; subject: string; text: string; threadId?: string; idempotencyKey?: string; idempotencyGroup?: string }
export interface BoxOxAgentOptions {
  /** A short-lived agent bearer, or a supplier that renews it before requests. Defaults to BOXOX_AGENT_TOKEN. */
  token?: string | (() => string | Promise<string>);
  /** Your installation origin. Defaults to BOXOX_URL. */
  url?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}
function environment(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}
function segment(value: string): string {
  if (!value) throw new Error("An address, thread or message ID is required");
  return encodeURIComponent(value);
}

function workReference(input: AgentWorkReference) {
  const { messageId, claimToken, group } = input;
  return { messageId, claimToken, ...(group == null ? {} : { group }) };
}

/** Agent bearer API. Separate from the developer API's bxk_/bxm_ key client. No mutation is retried automatically. */
export class BoxOxAgent {
  readonly #token: string | (() => string | Promise<string>);
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;
  constructor(options: BoxOxAgentOptions = {}) {
    const token = options.token ?? environment("BOXOX_AGENT_TOKEN");
    const url = options.url ?? environment("BOXOX_URL");
    if (!token) throw new Error("BoxOxAgent: pass `token` or set BOXOX_AGENT_TOKEN");
    if (!url) throw new Error("BoxOxAgent: pass `url` or set BOXOX_URL");
    const origin = new URL(url);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("BoxOxAgent URL must be an origin without credentials, path, query or fragment");
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("BoxOxAgent requires HTTPS, except on localhost");
    this.#token = token;
    this.#url = origin.origin;
    const fetcher = options.fetch ?? globalThis.fetch;
    this.#fetch = (...args) => fetcher(...args);
    this.#headers = options.headers ?? {};
  }
  async #call<T>(method: "GET" | "POST", path: string, options: { query?: object; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const token = typeof this.#token === "function" ? await this.#token() : this.#token;
    if (!token) throw new Error("BoxOxAgent token supplier returned an empty token");
    const url = new URL(`/api/agent/v1${path}`, this.#url);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { accept: "application/json", ...this.#headers, authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const response = await this.#fetch(url.href, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    if (!response.ok) {
      const reply = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new BoxOxError(response.status, reply?.error?.code ?? "http_error", reply?.error?.message ?? `HTTP ${response.status}`);
    }
    return await response.json() as T;
  }
  me() { return this.#call<{ agent: { id: string; name: string; clientId: string }; addresses: { addressId: string; permissions: string[] }[] }>("GET", "/me"); }
  changes(addressId: string, query: AgentPageOptions = {}) {
    return this.#call<{ changes: AgentChange[]; nextCursor: string; hasMore: boolean }>("GET", `/addresses/${segment(addressId)}/changes`, { query });
  }
  threads(addressId: string, query: AgentPageOptions = {}) {
    return this.#call<{ threads: AgentThread[]; nextCursor: string | null }>("GET", `/addresses/${segment(addressId)}/threads`, { query });
  }
  thread(threadId: string, query: AgentBodyOptions = {}) {
    return this.#call<{ thread: AgentThread; messages: AgentMessage[]; nextCursor: string | null }>("GET", `/threads/${segment(threadId)}`, { query });
  }
  message(messageId: string, query: { includeBody?: boolean } = {}) {
    return this.#call<{ threadId: string; message: AgentMessage }>("GET", `/messages/${segment(messageId)}`, { query });
  }
  send(body: AgentSendInput, options: { idempotencyKey?: string } = {}) {
    return this.#call<{ ok: true; threadId: string; messageId: string; sentMessageId: string }>("POST", "/send", { body, ...options });
  }
  readonly work = {
    pending: (addressId: string, query: AgentPageOptions & { group?: string } = {}) =>
      this.#call<{ messages: AgentPendingMessage[]; nextCursor: string | null }>("GET", `/addresses/${segment(addressId)}/work`, { query }),
    claim: (input: AgentWorkOptions & { messageId: string }) => this.#call<AgentWorkReceipt>("POST", "/work/claim", { body: input }),
    complete: (input: AgentWorkReference) => this.#call<{ messageId: string; completed: true }>("POST", "/work/complete", { body: workReference(input) }),
    completeBatch: (items: AgentWorkReference[]) => this.#call<{ results: { messageId: string; completed?: true; error?: { code: string; message: string } }[] }>("POST", "/work/complete-batch", { body: { items: items.map(workReference) } }),
    renew: (input: AgentWorkReference & { leaseSeconds?: number }) => this.#call<AgentWorkReceipt>("POST", "/work/renew", { body: { ...workReference(input), leaseSeconds: input.leaseSeconds } }),
    retry: (input: AgentWorkReference & { delaySeconds?: number }) => this.#call<{ messageId: string; availableAt: string }>("POST", "/work/retry", { body: { ...workReference(input), delaySeconds: input.delaySeconds } }),
  };
}
