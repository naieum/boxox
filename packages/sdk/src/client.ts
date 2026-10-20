import type { components, operations, paths } from "./schema.js";

export type Schemas = components["schemas"];
export type OperationId = keyof operations;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Success<R> = { [S in keyof R]: S extends 200 | 201 | 202 ? Json<R[S]> : never }[keyof R];

export type RequestBody<O extends OperationId> = operations[O] extends { requestBody?: infer R } ? Json<NonNullable<R>> : never;
export type Query<O extends OperationId> = NonNullable<operations[O]["parameters"]["query"]>;
export type PathParams<O extends OperationId> = NonNullable<operations[O]["parameters"]["path"]>;
export type Result<O extends OperationId> = Success<operations[O]["responses"]>;

/** The (method, path) pair the spec gives operation K; ROUTES must match it exactly. */
type RouteOf<K extends OperationId> = {
  [P in keyof paths]: {
    [M in Method]: paths[P][Lowercase<M> & keyof paths[P]] extends operations[K] ? readonly [M, P] : never;
  }[Method];
}[keyof paths];

/** Every operation in docs/api/openapi.json. Adding, moving or removing one there fails the type check here. */
export const ROUTES = {
  sendMessage: ["POST", "/dev/v1/messages"],
  sendBatch: ["POST", "/dev/v1/messages/batch"],
  listMessages: ["GET", "/dev/v1/messages"],
  getMessage: ["GET", "/dev/v1/messages/{id}"],
  rescheduleMessage: ["PATCH", "/dev/v1/messages/{id}"],
  cancelMessage: ["POST", "/dev/v1/messages/{id}/cancel"],
  listKeys: ["GET", "/dev/v1/keys"],
  createKey: ["POST", "/dev/v1/keys"],
  rotateKey: ["POST", "/dev/v1/keys/{id}/rotate"],
  revokeKey: ["POST", "/dev/v1/keys/{id}/revoke"],
  listTemplates: ["GET", "/dev/v1/templates"],
  createTemplate: ["POST", "/dev/v1/templates"],
  getTemplate: ["GET", "/dev/v1/templates/{name}"],
  listTemplateVersions: ["GET", "/dev/v1/templates/{name}/versions"],
  updateTemplate: ["PUT", "/dev/v1/templates/{name}"],
  previewTemplate: ["POST", "/dev/v1/templates/{name}/preview"],
  deleteTemplate: ["DELETE", "/dev/v1/templates/{name}"],
  createWebhook: ["POST", "/dev/v1/webhooks"],
  listWebhooks: ["GET", "/dev/v1/webhooks"],
  listenWebhooks: ["GET", "/dev/v1/webhooks/listen"],
  getWebhook: ["GET", "/dev/v1/webhooks/{id}"],
  updateWebhook: ["PATCH", "/dev/v1/webhooks/{id}"],
  deleteWebhook: ["DELETE", "/dev/v1/webhooks/{id}"],
  rotateWebhookSecret: ["POST", "/dev/v1/webhooks/{id}/rotate"],
  testWebhook: ["POST", "/dev/v1/webhooks/{id}/test"],
  listWebhookDeliveries: ["GET", "/dev/v1/webhooks/{id}/deliveries"],
  getWebhookDelivery: ["GET", "/dev/v1/webhooks/{id}/deliveries/{deliveryId}"],
  replayWebhookDelivery: ["POST", "/dev/v1/webhooks/{id}/deliveries/{deliveryId}/replay"],
  listReceived: ["GET", "/dev/v1/received"],
  getReceived: ["GET", "/dev/v1/received/{id}"],
  getReceivedRawUrl: ["GET", "/dev/v1/received/{id}/raw"],
  getReceivedAttachment: ["GET", "/dev/v1/received/{id}/attachments/{attachmentId}"],
  downloadReceivedRaw: ["GET", "/dev/v1/received/raw/{token}"],
  listSuppressions: ["GET", "/dev/v1/suppressions"],
  getSuppression: ["GET", "/dev/v1/suppressions/{email}"],
  addSuppression: ["POST", "/dev/v1/suppressions"],
  removeSuppression: ["DELETE", "/dev/v1/suppressions/{email}"],
} as const satisfies { [K in OperationId]: RouteOf<K> };

/** Operations that return bytes; the client hands back the raw Response. */
const BINARY = new Set<OperationId>(["getReceivedAttachment", "downloadReceivedRaw"]);

export interface CallInit<O extends OperationId> {
  path?: PathParams<O>;
  query?: Query<O>;
  body?: RequestBody<O>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface BoxOxOptions {
  /** A bxk_ domain key, or a bxm_ management key for `keys`. Defaults to BOXOX_KEY. */
  key?: string;
  /** Your Box Ox URL, e.g. https://mail.example.com. Defaults to BOXOX_URL. */
  url?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/** `{error:{code,message,param?}}` from the API, plus the HTTP status. Batch rejections carry `errors`. */
export class BoxOxError extends Error {
  readonly name = "BoxOxError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param?: string,
    readonly errors?: Schemas["BatchRejected"]["errors"],
  ) {
    super(message);
  }
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

type Page<T> = { data: T[]; nextCursor: string | null };

export class BoxOx {
  readonly #key: string;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: BoxOxOptions = {}) {
    const key = options.key ?? env("BOXOX_KEY");
    const url = options.url ?? env("BOXOX_URL");
    if (!key) throw new Error("BoxOx: pass `key` or set BOXOX_KEY");
    if (!url) throw new Error("BoxOx: pass `url` or set BOXOX_URL");
    this.#key = key;
    this.#url = url.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#headers = options.headers ?? {};
  }

  /** Calls any operation by its OpenAPI operationId. */
  async request<O extends OperationId>(op: O, init: CallInit<O> = {}): Promise<Result<O>> {
    const res = await this.#send(op, init);
    return (res.status === 204 ? undefined : await res.json()) as Result<O>;
  }

  /** Byte-returning operations: the Response, after the status check. */
  async download<O extends OperationId>(op: O, init: CallInit<O> = {}): Promise<Response> {
    if (!BINARY.has(op)) throw new Error(`${op} returns JSON; use request()`);
    return this.#send(op, init);
  }

  /** Follows nextCursor through every page of a list call. */
  async *paginate<Q extends { cursor?: string }, T>(list: (query?: Q) => Promise<Page<T>>, query?: NoInfer<Q>): AsyncGenerator<T> {
    let cursor = query?.cursor;
    do {
      const page = await list({ ...query, cursor } as Q);
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async #send<O extends OperationId>(op: O, init: CallInit<O>): Promise<Response> {
    const [method, template] = ROUTES[op];
    const params = (init.path ?? {}) as Record<string, string>;
    let path: string = template.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = params[name];
      if (value === undefined || value === "") throw new Error(`${op}: missing path parameter ${name}`);
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries((init.query ?? {}) as Record<string, unknown>)) {
      if (v !== undefined && v !== null) search.set(k, String(v));
    }
    if (search.size) path += `?${search}`;
    const headers: Record<string, string> = { accept: "application/json", ...this.#headers };
    if (op !== "downloadReceivedRaw") headers.authorization = `Bearer ${this.#key}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    const res = await this.#fetch(this.#url + path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    if (res.ok) return res;
    const err = (await res.json().catch(() => null)) as Partial<Schemas["BatchRejected"]> & { error?: Schemas["Error"]["error"] } | null;
    throw new BoxOxError(
      res.status,
      err?.error?.code ?? "http_error",
      err?.error?.message ?? `HTTP ${res.status}`,
      (err?.error as { param?: string } | undefined)?.param,
      err?.errors,
    );
  }

  readonly messages = {
    send: (body: RequestBody<"sendMessage">, opts: { idempotencyKey?: string } = {}) => this.request("sendMessage", { body, ...opts }),
    batch: (body: RequestBody<"sendBatch">, opts: { idempotencyKey?: string } = {}) => this.request("sendBatch", { body, ...opts }),
    list: (query: Query<"listMessages"> = {}) => this.request("listMessages", { query }),
    get: (id: string) => this.request("getMessage", { path: { id } }),
    reschedule: (id: string, sendAt: string) => this.request("rescheduleMessage", { path: { id }, body: { sendAt } }),
    cancel: (id: string) => this.request("cancelMessage", { path: { id } }),
  };

  readonly keys = {
    list: () => this.request("listKeys"),
    create: (body: RequestBody<"createKey">) => this.request("createKey", { body }),
    rotate: (id: string, body: RequestBody<"rotateKey"> = {}) => this.request("rotateKey", { path: { id }, body }),
    revoke: (id: string) => this.request("revokeKey", { path: { id } }),
  };

  readonly templates = {
    list: (query: Query<"listTemplates"> = {}) => this.request("listTemplates", { query }),
    create: (body: RequestBody<"createTemplate">) => this.request("createTemplate", { body }),
    get: (name: string, version?: number) => this.request("getTemplate", { path: { name }, query: { version } }),
    versions: (name: string) => this.request("listTemplateVersions", { path: { name } }),
    update: (name: string, body: RequestBody<"updateTemplate">) => this.request("updateTemplate", { path: { name }, body }),
    preview: (name: string, body: RequestBody<"previewTemplate"> = {}) => this.request("previewTemplate", { path: { name }, body }),
    delete: (name: string) => this.request("deleteTemplate", { path: { name } }),
  };

  readonly webhooks = {
    /** Open the authenticated developer stream with the runtime's WebSocket implementation. */
    listen: <T>(connect: (url: string, headers: Record<string, string>) => T): T => {
      const url = new URL(ROUTES.listenWebhooks[1], this.#url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return connect(url.href, { ...this.#headers, authorization: `Bearer ${this.#key}` });
    },
    create: (body: RequestBody<"createWebhook">) => this.request("createWebhook", { body }),
    list: () => this.request("listWebhooks"),
    get: (id: string) => this.request("getWebhook", { path: { id } }),
    update: (id: string, body: RequestBody<"updateWebhook">) => this.request("updateWebhook", { path: { id }, body }),
    delete: (id: string) => this.request("deleteWebhook", { path: { id } }),
    rotateSecret: (id: string, body: RequestBody<"rotateWebhookSecret"> = {}) => this.request("rotateWebhookSecret", { path: { id }, body }),
    test: (id: string) => this.request("testWebhook", { path: { id } }),
    deliveries: {
      list: (id: string, query: Query<"listWebhookDeliveries"> = {}) => this.request("listWebhookDeliveries", { path: { id }, query }),
      get: (id: string, deliveryId: string) => this.request("getWebhookDelivery", { path: { id, deliveryId } }),
      replay: (id: string, deliveryId: string) => this.request("replayWebhookDelivery", { path: { id, deliveryId } }),
    },
  };

  readonly received = {
    list: (query: Query<"listReceived"> = {}) => this.request("listReceived", { query }),
    get: (id: string) => this.request("getReceived", { path: { id } }),
    rawUrl: (id: string, expiresIn?: number) => this.request("getReceivedRawUrl", { path: { id }, query: { expiresIn } }),
    attachment: (id: string, attachmentId: string) => this.download("getReceivedAttachment", { path: { id, attachmentId } }),
    /** Fetches the .eml behind a signed `rawUrl` token; the token is the credential. */
    raw: (token: string) => this.download("downloadReceivedRaw", { path: { token } }),
  };

  readonly suppressions = {
    list: (query: Query<"listSuppressions"> = {}) => this.request("listSuppressions", { query }),
    get: (email: string) => this.request("getSuppression", { path: { email } }),
    add: (body: RequestBody<"addSuppression">) => this.request("addSuppression", { body }),
    remove: (email: string) => this.request("removeSuppression", { path: { email } }),
  };
}
