import type { Env } from "../../env";

/**
 * Cloudflare API client for /setup and the domain pages. Shapes come from the
 * Phase 0 spikes (docs/spikes/email.md, ai.md, platform.md); the recorded
 * responses live in test/fixtures/cf/.
 *
 * The token is optional at runtime: the app works without it after setup, so
 * every method fails with TokenNotConfiguredError instead of at construction.
 */

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export const DELIVERY_EVENTS = [
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
] as const;

const CF_MX_SUFFIX = ".mx.cloudflare.net";
const CF_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";
const DEFAULT_MULTIPART_ABORT_DAYS = 7;
const DAY_SECONDS = 86_400;

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: { code: number; message: string }[] = [],
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }

  get code(): number | undefined {
    return this.errors[0]?.code;
  }
}

export class TokenNotConfiguredError extends Error {
  constructor(what = "CF_API_TOKEN") {
    super(
      `Cloudflare API token not configured: set the ${what} secret (wrangler secret put ${what}) to use setup and domain management`,
    );
    this.name = "TokenNotConfiguredError";
  }
}

export interface Zone {
  id: string;
  name: string;
  status: string;
  account?: { id: string; name?: string };
}

export interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  priority?: number;
  ttl: number;
}

export interface RoutingSettings {
  id: string;
  name: string;
  enabled: boolean;
  support_subaddress: boolean;
  synced: boolean;
  status?: string;
  errors?: { code: string; existing?: DnsRecord }[];
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
  priority: number;
}

export interface SendingSubdomain {
  id: string;
  name: string;
  enabled: boolean;
  return_path_domain: string;
  dkim_selector: string;
}

export interface SendingDnsStatus {
  status: string;
  records: Omit<DnsRecord, "id">[];
  errors: unknown[];
}

export interface SendingLimits {
  quota: { value: number; unit: string };
  usage: { sent: number; over_quota: boolean; resets_at: string | null };
}

export interface EventSubscription {
  id: string;
  name: string;
  enabled: boolean;
  source: { type: string; zone_id?: string; domain?: string };
  destination: { type: string; queue_id: string };
  events: string[];
}

export interface Queue {
  queue_id: string;
  queue_name: string;
}

export interface LifecycleRule {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  deleteObjectsTransition?: { condition: { type: "Age"; maxAge: number } };
  abortMultipartUploadsTransition?: { condition: { type: "Age"; maxAge: number } };
  storageClassTransitions?: unknown[];
}

export interface SpendLimitRule {
  id: string;
  limitType: "cost";
  limit: number;
  window: number;
  technique: "fixed" | "sliding";
}

export interface Gateway {
  id: string;
  collect_logs: boolean;
  zdr?: boolean;
  spend_limits?: { enabled: boolean; rules: SpendLimitRule[] };
  [key: string]: unknown;
}

export interface CreditBalance {
  balance: number;
  has_default_payment_method: boolean;
}

/** What turning routing on would remove; the wizard shows this and asks first. */
export interface MxReplacementPlan {
  foreignMx: DnsRecord[];
  foreignSpf: DnsRecord | null;
  warning: string | null;
}

export type OnboardResult =
  | { status: "needs-confirmation"; zone: Zone; plan: MxReplacementPlan }
  | {
      status: "onboarded";
      zone: Zone;
      routing: RoutingSettings | null;
      sending: SendingSubdomain | null;
      removedMx: DnsRecord[];
      replacedSpf: { id: string; from: string; to: string } | null;
    };

export interface CloudflareClientOptions {
  token?: string;
  accountId?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

const isCloudflareMx = (r: DnsRecord) => r.content.replace(/\.$/, "").toLowerCase().endsWith(CF_MX_SUFFIX);
const unquote = (s: string) => s.replace(/^"|"$/g, "");
const isSpf = (r: DnsRecord) => r.type === "TXT" && /^v=spf1(\s|$)/i.test(unquote(r.content));

/**
 * The SPF record Email Routing accepts, keeping the domain's other senders.
 * `v=spf1 -all` becomes `v=spf1 include:_spf.mx.cloudflare.net ~all`, the value
 * the spike confirmed takes routing from `misconfigured/locked` to `ready`.
 */
export function mergeSpf(existing: string): string {
  const terms = unquote(existing).trim().split(/\s+/).slice(1);
  const kept = terms.filter((t) => !/^[-~?+]?all$/i.test(t) && t.toLowerCase() !== CF_SPF_INCLUDE);
  return `"${["v=spf1", CF_SPF_INCLUDE, ...kept, "~all"].join(" ")}"`;
}

/**
 * Lifecycle PUT replaces the whole rule set, Cloudflare's default multipart
 * abort rule included (platform spike, finding 5). Keep every other rule,
 * replace ours by id, and make sure some multipart-abort rule survives.
 */
export function mergeLifecycleRules(existing: LifecycleRule[], ours: LifecycleRule[]): LifecycleRule[] {
  const ids = new Set(ours.map((r) => r.id));
  const merged = [...existing.filter((r) => !ids.has(r.id)), ...ours];
  if (!merged.some((r) => r.abortMultipartUploadsTransition)) {
    merged.push({
      id: "boxox-multipart-abort",
      enabled: true,
      conditions: { prefix: "" },
      abortMultipartUploadsTransition: {
        condition: { type: "Age", maxAge: DEFAULT_MULTIPART_ABORT_DAYS * DAY_SECONDS },
      },
    });
  }
  return merged;
}

export class CloudflareClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: CloudflareClientOptions) {
    // Workers' native fetch rejects a CloudflareClient receiver (Illegal invocation).
    // Call supplied functions as plain functions, including the OAuth callback's fetch.
    const fetcher = opts.fetch ?? fetch;
    this.fetcher = (input, init) => fetcher(input, init);
    this.baseUrl = opts.baseUrl ?? CF_API_BASE;
  }

  get configured(): boolean {
    return !!this.opts.token && !!this.opts.accountId;
  }

  private get account(): string {
    if (!this.opts.token) throw new TokenNotConfiguredError();
    if (!this.opts.accountId) throw new TokenNotConfiguredError("CF_ACCOUNT_ID");
    return this.opts.accountId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.opts.token) throw new TokenNotConfiguredError();
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.success) {
      const errors = json?.errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new CloudflareApiError(`Cloudflare API ${method} ${path} failed: ${detail}`, res.status, errors);
    }
    return json.result;
  }

  // Zones and DNS

  async findZone(name: string): Promise<Zone> {
    const zones = await this.request<Zone[]>(
      "GET",
      `/zones?name=${encodeURIComponent(name)}&account.id=${this.account}`,
    );
    const zone = zones.find((z) => z.name === name);
    if (!zone) throw new CloudflareApiError(`Zone ${name} is not in this Cloudflare account`, 404);
    return zone;
  }

  /** Zones in this account only; a token scoped wider still never shows other accounts' zones. */
  async listZones(): Promise<Zone[]> {
    const account = this.account;
    const zones = await this.request<Zone[]>("GET", `/zones?account.id=${account}&per_page=50`);
    return zones.filter((z) => z.account?.id === account);
  }

  async listDnsRecords(zoneId: string, filter: { type?: string; name?: string } = {}): Promise<DnsRecord[]> {
    const q = new URLSearchParams({ per_page: "100", ...filter });
    return this.request("GET", `/zones/${zoneId}/dns_records?${q}`);
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
  }

  async updateDnsRecordContent(zoneId: string, recordId: string, content: string): Promise<DnsRecord> {
    return this.request("PATCH", `/zones/${zoneId}/dns_records/${recordId}`, { content });
  }

  /**
   * Turning routing on replaces the apex MX, and Cloudflare refuses while a
   * foreign MX (2008) or foreign apex SPF (`spf.foreign`) is present. Reports
   * both so the wizard can warn before anything changes.
   */
  async planMxReplacement(zone: Zone): Promise<MxReplacementPlan> {
    const [mx, txt] = await Promise.all([
      this.listDnsRecords(zone.id, { type: "MX", name: zone.name }),
      this.listDnsRecords(zone.id, { type: "TXT", name: zone.name }),
    ]);
    const foreignMx = mx.filter((r) => r.name === zone.name && !isCloudflareMx(r));
    const spf = txt.find((r) => r.name === zone.name && isSpf(r)) ?? null;
    const foreignSpf = spf && !unquote(spf.content).toLowerCase().includes(CF_SPF_INCLUDE) ? spf : null;
    const warning = foreignMx.length
      ? `Turning on Email Routing replaces the MX records of ${zone.name}: ${foreignMx
          .map((r) => `${r.content} (${r.priority ?? 0})`)
          .join(", ")}. All mail for ${zone.name} will move to Box Ox${
          foreignMx.some((r) => /google|outlook|microsoft/i.test(r.content))
            ? ", and your current provider (Google Workspace or Microsoft 365) will stop receiving it"
            : ""
        }.`
      : null;
    return { foreignMx, foreignSpf, warning };
  }

  // Email Routing

  async getRoutingSettings(zoneId: string): Promise<RoutingSettings> {
    return this.request("GET", `/zones/${zoneId}/email/routing`);
  }

  async enableRouting(zoneId: string): Promise<RoutingSettings> {
    return this.request("POST", `/zones/${zoneId}/email/routing/enable`, {});
  }

  async getRoutingDns(zoneId: string): Promise<Omit<DnsRecord, "id">[]> {
    return this.request("GET", `/zones/${zoneId}/email/routing/dns`);
  }

  async setSubaddressing(zoneId: string, enabled: boolean): Promise<RoutingSettings> {
    return this.request("PATCH", `/zones/${zoneId}/email/routing`, { support_subaddress: enabled });
  }

  async getCatchAll(zoneId: string): Promise<RoutingRule> {
    return this.request("GET", `/zones/${zoneId}/email/routing/rules/catch_all`);
  }

  async setCatchAllToWorker(zoneId: string, workerName: string): Promise<RoutingRule> {
    return this.request("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      enabled: true,
      name: "Box Ox catch-all",
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [workerName] }],
    });
  }

  // Email Sending

  async listSendingSubdomains(zoneId: string): Promise<SendingSubdomain[]> {
    return this.request("GET", `/zones/${zoneId}/email/sending/subdomains`);
  }

  async enableSending(zoneId: string, domain: string): Promise<SendingSubdomain> {
    const existing = (await this.listSendingSubdomains(zoneId)).find((s) => s.name === domain);
    if (existing) return existing;
    return this.request("POST", `/zones/${zoneId}/email/sending/subdomains`, { name: domain });
  }

  async getSendingDnsStatus(zoneId: string, subdomainId: string): Promise<SendingDnsStatus> {
    return this.request("GET", `/zones/${zoneId}/email/sending/subdomains/${subdomainId}/dns/status`);
  }

  async getSendingLimits(): Promise<SendingLimits> {
    return this.request("GET", `/accounts/${this.account}/email/sending/limits`);
  }

  /**
   * Sending always; routing (apex only) when asked. Foreign MX or SPF without
   * `confirmMxReplacement` returns the plan and changes nothing. Routing can
   * report `enabled: true` while `misconfigured/locked`, so check `status`.
   */
  async onboardZone(
    domain: string,
    opts: { routing: boolean; confirmMxReplacement?: boolean; sending?: boolean },
  ): Promise<OnboardResult> {
    const zone = await this.findZone(domain);
    let routing: RoutingSettings | null = null;
    const removedMx: DnsRecord[] = [];
    let replacedSpf: { id: string; from: string; to: string } | null = null;

    if (opts.routing) {
      const plan = await this.planMxReplacement(zone);
      if ((plan.foreignMx.length || plan.foreignSpf) && !opts.confirmMxReplacement) {
        return { status: "needs-confirmation", zone, plan };
      }
      for (const r of plan.foreignMx) {
        await this.deleteDnsRecord(zone.id, r.id);
        removedMx.push(r);
      }
      if (plan.foreignSpf) {
        const to = mergeSpf(plan.foreignSpf.content);
        await this.updateDnsRecordContent(zone.id, plan.foreignSpf.id, to);
        replacedSpf = { id: plan.foreignSpf.id, from: plan.foreignSpf.content, to };
      }
      routing = await this.enableRouting(zone.id);
      if (routing.status !== "ready") routing = await this.getRoutingSettings(zone.id);
    }

    const sending = opts.sending === false ? null : await this.enableSending(zone.id, zone.name);
    return { status: "onboarded", zone, routing, sending, removedMx, replacedSpf };
  }

  // Event subscriptions

  async findQueue(name: string): Promise<Queue> {
    const queues = await this.request<Queue[]>(
      "GET",
      `/accounts/${this.account}/queues?name=${encodeURIComponent(name)}`,
    );
    const queue = queues.find((q) => q.queue_name === name);
    if (!queue) throw new CloudflareApiError(`Queue ${name} not found`, 404);
    return queue;
  }

  async listEventSubscriptions(): Promise<EventSubscription[]> {
    return this.request("GET", `/accounts/${this.account}/event_subscriptions/subscriptions`);
  }

  /**
   * One subscription per sending domain. Takes the queue id, not its name.
   * Short event names go in; events arrive as `cf.email.sending.message.*`.
   */
  async subscribeDeliveryEvents(input: { zoneId: string; domain: string; queueId: string }): Promise<EventSubscription> {
    const existing = (await this.listEventSubscriptions()).find(
      (s) =>
        s.source.type === "email.sending" &&
        s.source.domain === input.domain &&
        s.destination.queue_id === input.queueId,
    );
    if (existing) return existing;
    return this.request("POST", `/accounts/${this.account}/event_subscriptions/subscriptions`, {
      name: `boxox-email-events-${input.domain.replace(/\./g, "-")}`,
      enabled: true,
      source: { type: "email.sending", zone_id: input.zoneId, domain: input.domain },
      destination: { type: "queues.queue", queue_id: input.queueId },
      events: [...DELIVERY_EVENTS],
    });
  }

  async deleteEventSubscription(id: string): Promise<void> {
    await this.request("DELETE", `/accounts/${this.account}/event_subscriptions/subscriptions/${id}`);
  }

  // R2 lifecycle

  async getBucketLifecycle(bucket: string): Promise<LifecycleRule[]> {
    const res = await this.request<{ rules?: LifecycleRule[] }>(
      "GET",
      `/accounts/${this.account}/r2/buckets/${bucket}/lifecycle`,
    );
    return res.rules ?? [];
  }

  async applyRetentionLifecycle(bucket: string, rules: { prefix: string; days: number }[]): Promise<LifecycleRule[]> {
    const ours: LifecycleRule[] = rules.map((r) => ({
      id: `boxox-expire-${r.prefix.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "all"}`,
      enabled: true,
      conditions: { prefix: r.prefix },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: r.days * DAY_SECONDS } },
    }));
    const merged = mergeLifecycleRules(await this.getBucketLifecycle(bucket), ours);
    await this.request("PUT", `/accounts/${this.account}/r2/buckets/${bucket}/lifecycle`, { rules: merged });
    return merged;
  }

  // AI Gateway

  async getCreditBalance(): Promise<CreditBalance> {
    return this.request("GET", `/accounts/${this.account}/ai-gateway/billing/credit-balance`);
  }

  /**
   * ZDR on, logging off and a daily cost limit. The gateway has no payload-only
   * logging (AI spike, finding 3), so `collect_logs` goes off entirely; a PUT
   * replaces the gateway, so the current settings are read and kept.
   */
  async applyGatewaySettings(gatewayId: string, opts: { dailySpendLimitUsd: number }): Promise<Gateway> {
    const path = `/accounts/${this.account}/ai-gateway/gateways`;
    let current: Gateway | null = null;
    try {
      current = await this.request<Gateway>("GET", `${path}/${gatewayId}`);
    } catch (err) {
      if (!(err instanceof CloudflareApiError && err.status === 404)) throw err;
    }
    const otherRules = (current?.spend_limits?.rules ?? []).filter((r) => r.id !== "boxox-daily");
    const body = {
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      ...stripReadOnly(current),
      id: gatewayId,
      cache_ttl: 0,
      cache_invalidate_on_update: false,
      collect_logs: false,
      authentication: true,
      byok_only: false,
      zdr: true,
      spend_limits: {
        enabled: true,
        rules: [
          ...otherRules,
          {
            id: "boxox-daily",
            limitType: "cost",
            limit: opts.dailySpendLimitUsd,
            window: DAY_SECONDS,
            technique: "fixed",
          },
        ],
      },
    };
    return current
      ? this.request("PUT", `${path}/${gatewayId}`, body)
      : this.request("POST", path, body);
  }
}

function stripReadOnly(g: Gateway | null): Partial<Gateway> {
  if (!g) return {};
  const { created_at: _c, modified_at: _m, account_id: _a, account_tag: _t, internal_id: _i, ...rest } = g;
  return rest;
}

export function cloudflareClient(
  env: Pick<Env, "CF_API_TOKEN" | "CF_ACCOUNT_ID">,
  fetcher?: typeof fetch,
): CloudflareClient {
  return new CloudflareClient({ token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID, fetch: fetcher });
}
