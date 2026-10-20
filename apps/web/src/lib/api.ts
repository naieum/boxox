import type {
  AddressKind,
  AddressStatus,
  GrantPermission,
  ThreadFolder,
  UnknownMailPolicy,
} from "@boxox/shared";

class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Extra fields some error bodies attach alongside code/message, e.g. plan_limit's limit/current. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}
export { ApiRequestError };

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // The worker refuses mutating requests without it (requireSameOrigin).
    headers: { "Content-Type": "application/json", "x-boxox-csrf": "1", ...init?.headers },
  });
  if (!res.ok) {
    let code = "unknown";
    let message = `Request failed (${res.status})`;
    let details: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as {
        error?: { code: string; message: string } & Record<string, unknown>;
      } & Record<string, unknown>;
      if (body.error) {
        ({ code, message } = body.error);
        // Keep the SIBLING fields, not just error.*. A failed send returns
        // top-level { saved, messageId, threadId } to say the message is durable.
        // Dropping them leaves callers unable to tell "gone" from "saved", and
        // re-arming Send would compose a duplicate.
        const { error: _error, ...rest } = body;
        details = { ...body.error, ...rest };
      }
    } catch {
      // non-JSON error body
    }
    throw new ApiRequestError(res.status, code, message, details);
  }
  return res.json() as Promise<T>;
}

// ---------- Shapes returned by the worker ----------

export interface DomainRow {
  id: string;
  name: string;
  status: string;
  region: string | null;
  unknownMailPolicy: UnknownMailPolicy;
  catchAllAddressId: string | null;
  addressCount: number;
  lastSyncedAt: string | null;
  active: boolean;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  health: DomainHealth | null;
  healthCheckedAt: string | null;
}

export interface DomainHealthCheck {
  name: "dkim" | "spf" | "dmarc" | "mx" | "bimi";
  host: string;
  type: "TXT" | "MX";
  required: boolean;
  status: "ok" | "missing" | "invalid" | "unknown";
  found: string[];
  detail?: string;
}

export interface DomainHealth {
  healthy: boolean;
  checks: DomainHealthCheck[];
  checkedAt: string;
  alerts?: { at: string; kind: "problem" | "recovered"; checks: string[] }[];
  reputation?: { status: "clear" | "listed" | "unknown" | "off"; lastKnown?: "clear" | "listed"; detail: string };
}

export type SendingQuota =
  | { configured: false }
  | {
      configured: true;
      limit: number;
      unit: string;
      sent: number;
      remaining: number;
      overQuota: boolean;
      resetsAt: string | null;
    };

export interface ZoneRow {
  id: string;
  name: string;
  status: string;
  onboarded: boolean;
}

export interface GrantRow {
  id: string;
  addressId: string;
  principalType: "user" | "agent";
  principalId: string | null;
  inviteEmail: string | null;
  permissions: GrantPermission[];
}

export interface AddressRow {
  id: string;
  localPart: string;
  kind: AddressKind;
  displayName: string | null;
  status: AddressStatus;
  expiresAt: string | null;
  unread: number;
  grants: GrantRow[];
}

export interface SidebarAddress {
  id: string;
  localPart: string;
  kind: AddressKind;
  displayName: string | null;
  status: AddressStatus;
  domainId: string;
  domainName: string;
  email: string;
  unread: number;
  canSend: boolean;
}

export interface ThreadRow {
  id: string;
  subject: string;
  snippet: string;
  folder: ThreadFolder;
  starred: boolean;
  unread: boolean;
  priority?: number | null;
  category?: string | null;
  messageCount: number;
  lastMessageAt: string;
  counterpartyEmail: string | null;
  counterpartyName: string | null;
  addressId: string | null;
  originalRecipient: string | null;
  address: string;
}

export interface MessageDetail {
  id: string;
  direction: "inbound" | "outbound";
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  snippet: string;
  /** Inbound sender authentication (DMARC / aligned SPF+DKIM); outbound is true. */
  authenticated: boolean;
  html: string | null;
  text: string | null;
  attachments: {
    filename: string;
    size: number;
    index: number;
    messageId: string;
    /** True when the attachment was too large to store — no bytes to download. */
    truncated: boolean;
  }[];
  occurredAt: string;
}

export interface ThreadDetail {
  thread: {
    id: string;
    subject: string;
    folder: ThreadFolder;
    starred: boolean;
    unread: boolean;
    priority?: number | null;
    category?: string | null;
    addressId: string | null;
    domainId: string | null;
    originalRecipient: string | null;
    counterpartyEmail: string | null;
    counterpartyName: string | null;
  };
  messages: MessageDetail[];
}

export type ThreadAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "trash"
  | "restore"
  | "spam"
  | "not_spam"
  | "block_sender";

export interface AgentGrantRow {
  id: string;
  addressId: string;
  email: string;
  permissions: GrantPermission[];
}

export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "disabled";
  clientId: string;
  paired: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  grants: AgentGrantRow[];
}

export type ComposeMode = "new" | "reply" | "reply_all" | "forward" | "forward_eml";

export interface DraftRow {
  id: string;
  fromAddressId: string;
  threadId: string | null;
  replyToMessageId: string | null;
  mode: ComposeMode;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  snippet: string;
  attachments: { index: number; filename: string; contentType: string; size: number }[];
  sendAt: string | null;
  updatedAt: string;
}

export type DraftFields = Partial<
  Pick<DraftRow, "fromAddressId" | "threadId" | "replyToMessageId" | "mode" | "to" | "cc" | "bcc" | "subject" | "text" | "html" | "sendAt">
>;

export interface ReplyContext {
  mode: ComposeMode;
  replyToMessageId: string;
  fromAddressId: string | null;
  threadId: string | null;
  to: string[];
  cc: string[];
  subject: string;
  quote: string;
  snippet: string;
  attachments: { filename: string; size: number }[];
  canForwardEml: boolean;
}

export interface SendResult {
  ok: true;
  threadId: string;
  messageId: string;
  scheduled: boolean;
  links: { id: string; filename: string; url: string; expiresAt: string }[];
}

export interface DraftSendOptions {
  sendAt?: string | null;
  attachmentsMode?: "link" | "fail";
  linkExpiresInDays?: number;
  includeOriginalAttachments?: boolean;
}

export interface Capabilities {
  edition: "free" | "paid";
  receiving: boolean;
  sending: boolean;
  ai: boolean;
  semanticSearch: boolean;
  browser: boolean;
  webhooks: boolean;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: string;
}

// ---------- Client ----------

export type ProcessingProvider = "openai" | "anthropic" | "cloudflare";
export interface ProcessingChoices {
  localFilters: boolean | null;
  reputationLookups: boolean | null;
  ai: boolean | null;
  provider: ProcessingProvider | null;
  ownerRules: string[];
  dailyBudgetMicros: number;
  onlyWhenUncertain: boolean;
}
export interface ProcessingSettings {
  capabilities?: Capabilities;
  processing: ProcessingChoices;
  tokenConfigured: boolean;
  groups: { id: "localFilters" | "reputationLookups" | "ai"; title: string; summary: string }[];
  providers: { id: ProcessingProvider; label: string; dataNote: string; termsUrl: string; models: { use: string; model: string }[]; needsCredits: boolean }[];
  addresses: { id: string; email: string; aiDisabled: boolean }[];
  warnings?: string[];
}

export const api = {
  processingSettings: () => request<ProcessingSettings>("/api/settings/processing"),
  updateProcessing: (body: Partial<ProcessingChoices>) => request<ProcessingSettings>("/api/settings/processing", { method: "PATCH", body: JSON.stringify(body) }),
  setAddressAiDisabled: (id: string, aiDisabled: boolean) => request<{ id: string; aiDisabled: boolean }>(`/api/settings/processing/addresses/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ aiDisabled }) }),
  me: () => request<{ user: Me; capabilities?: Capabilities }>("/api/me"),
  domains: {
    list: (orgId: string) => request<{ domains: DomainRow[] }>(`/api/orgs/${orgId}/domains`),
    patch: (orgId: string, domainId: string, body: { unknownMailPolicy?: UnknownMailPolicy; catchAllAddressId?: string | null }) =>
      request<{ ok: true }>(`/api/orgs/${orgId}/domains/${domainId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    addresses: (orgId: string, domainId: string) =>
      request<{ addresses: AddressRow[] }>(`/api/orgs/${orgId}/domains/${domainId}/addresses`),
    createAddress: (
      orgId: string,
      domainId: string,
      body: {
        localPart?: string;
        generate?: boolean;
        kind: AddressKind;
        displayName?: string;
        grantEmail?: string;
      },
    ) =>
      request<{ id: string; localPart: string; domain: string }>(
        `/api/orgs/${orgId}/domains/${domainId}/addresses`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    setActive: (orgId: string, domainId: string, active: boolean) =>
      request<{ ok: true }>(`/api/orgs/${orgId}/domains/${domainId}/active`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      }),
    checkHealth: (orgId: string, domainId: string) =>
      request<DomainHealth>(`/api/orgs/${orgId}/domains/${domainId}/health`, {
        method: "POST",
        headers: { "x-boxox-csrf": "1" },
      }),
    quota: (orgId: string) => request<SendingQuota>(`/api/orgs/${orgId}/domains/quota`),
    zones: (orgId: string) =>
      request<{ configured: boolean; zones: ZoneRow[]; oauthAvailable?: boolean; connectionError?: string; connection?: { temporary: boolean; expiresAt: number | null; oauth?: boolean } }>(`/api/orgs/${orgId}/domains/zones`),
    authorize: (orgId: string) => request<{ url: string }>(`/api/orgs/${orgId}/domains/connection/oauth`, { method: "POST" }),
    connect: (orgId: string, token: string) => request<{ ok: true; expiresAt: number }>(`/api/orgs/${orgId}/domains/connection`, { method: "POST", body: JSON.stringify({ token }) }),
    disconnect: (orgId: string) => request<{ ok: true }>(`/api/orgs/${orgId}/domains/connection`, { method: "DELETE" }),
  },
  addresses: {
    list: (orgId: string) =>
      request<{ addresses: SidebarAddress[]; unroutedCount: number }>(
        `/api/orgs/${orgId}/addresses`,
      ),
    patch: (
      orgId: string,
      addressId: string,
      body: { kind?: AddressKind; status?: AddressStatus; displayName?: string | null },
    ) =>
      request<{ ok: true }>(`/api/orgs/${orgId}/addresses/${addressId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    addGrant: (orgId: string, addressId: string, body: { email: string; permissions: GrantPermission[] }) =>
      request<{ id: string }>(`/api/orgs/${orgId}/addresses/${addressId}/grants`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    removeGrant: (orgId: string, addressId: string, grantId: string) =>
      request<{ ok: true }>(`/api/orgs/${orgId}/addresses/${addressId}/grants/${grantId}`, {
        method: "DELETE",
      }),
  },
  threads: {
    list: (
      orgId: string,
      params: { folder: string; addressId?: string; unread?: boolean; cursor?: string },
    ) => {
      const q = new URLSearchParams({ folder: params.folder });
      if (params.addressId) q.set("addressId", params.addressId);
      if (params.unread) q.set("unread", "true");
      // Keyset cursor from the previous page; omitted means "first page".
      if (params.cursor) q.set("cursor", params.cursor);
      return request<{ threads: ThreadRow[]; nextCursor: string | null }>(
        `/api/orgs/${orgId}/threads?${q}`,
      );
    },
    /** Full-text search across the caller's accessible mail. Returns threads. */
    search: (orgId: string, q: string) =>
      request<{ query: string; threads: ThreadRow[] }>(
        `/api/orgs/${orgId}/threads/search?q=${encodeURIComponent(q)}`,
      ),
    get: (orgId: string, threadId: string) =>
      request<ThreadDetail>(`/api/orgs/${orgId}/threads/${threadId}`),
    claim: (
      orgId: string,
      threadId: string,
      body: { mode: "create"; kind?: AddressKind } | { mode: "redirect"; addressId: string },
    ) =>
      request<{ ok: true; addressId: string }>(`/api/orgs/${orgId}/threads/${threadId}/claim`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    act: (orgId: string, threadId: string, action: ThreadAction) =>
      request<{ ok: true }>(`/api/orgs/${orgId}/threads/${threadId}/actions`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
  },
  send: (
    orgId: string,
    body: {
      fromAddressId: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      text: string;
      threadId?: string;
      replyToMessageId?: string;
      mode?: ComposeMode;
      sendAt?: string;
    },
  ) => request<SendResult>(`/api/orgs/${orgId}/send`, { method: "POST", body: JSON.stringify({ cc: [], ...body }) }),
  replyContext: (orgId: string, messageId: string, mode: ComposeMode) =>
    request<ReplyContext>(`/api/orgs/${orgId}/send/context/${messageId}?mode=${mode}`),
  drafts: {
    list: (orgId: string) => request<{ drafts: DraftRow[] }>(`/api/orgs/${orgId}/drafts`),
    get: (orgId: string, draftId: string) => request<{ draft: DraftRow }>(`/api/orgs/${orgId}/drafts/${draftId}`),
    create: (orgId: string, body: DraftFields & { fromAddressId: string }) =>
      request<{ draft: DraftRow }>(`/api/orgs/${orgId}/drafts`, { method: "POST", body: JSON.stringify(body) }),
    update: (orgId: string, draftId: string, body: DraftFields) =>
      request<{ draft: DraftRow }>(`/api/orgs/${orgId}/drafts/${draftId}`, { method: "PATCH", body: JSON.stringify(body) }),
    remove: (orgId: string, draftId: string) =>
      request<{ ok: true }>(`/api/orgs/${orgId}/drafts/${draftId}`, { method: "DELETE" }),
    upload: (orgId: string, draftId: string, file: File) =>
      request<{ draft: DraftRow }>(
        `/api/orgs/${orgId}/drafts/${draftId}/attachments?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } },
      ),
    removeAttachment: (orgId: string, draftId: string, index: number) =>
      request<{ draft: DraftRow }>(`/api/orgs/${orgId}/drafts/${draftId}/attachments/${index}`, { method: "DELETE" }),
    send: (orgId: string, draftId: string, opts: DraftSendOptions = {}) =>
      request<SendResult>(`/api/orgs/${orgId}/drafts/${draftId}/send`, { method: "POST", body: JSON.stringify(opts) }),
  },
  agents: {
    list: (orgId: string) => request<{ agents: AgentRow[] }>(`/api/orgs/${orgId}/agents`),
    create: (
      orgId: string,
      body: {
        name: string;
        description?: string;
        addressId?: string;
        permissions?: GrantPermission[];
      },
    ) => request<{ agent: AgentRow }>(`/api/orgs/${orgId}/agents`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    patch: (
      orgId: string,
      agentId: string,
      body: { name?: string; description?: string | null; status?: "active" | "disabled" },
    ) => request<{ ok: true }>(`/api/orgs/${orgId}/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    remove: (orgId: string, agentId: string) =>
      request<{ ok: true }>(`/api/orgs/${orgId}/agents/${agentId}`, { method: "DELETE" }),
    pairingCode: (orgId: string, agentId: string) =>
      request<{ code: string; expiresAt: string }>(
        `/api/orgs/${orgId}/agents/${agentId}/pairing-code`,
        { method: "POST" },
      ),
  },
};
