import { Hono } from "hono";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { API_KEY_KINDS, ATTACHMENT_RISKS, DOMAIN_KEY_PERMISSIONS, MESSAGE_EVENT_TYPES, suppressions } from "@boxox/db";
import { apiCreateSchema, devKeyRoutes, rotateSchema as keyRotateSchema } from "./keys-routes";
import { batchSchema, LIST_STATUSES, rescheduleSchema, sendSchema } from "./messages";
import { devMessageRoutes, listQuery as messageListQuery } from "./messages-routes";
import { devReceivedRoutes, listQuery as receivedListQuery, rawQuery } from "./received-routes";
import { addSuppressionSchema } from "./suppressions";
import { devSuppressionRoutes, listQuery as suppressionListQuery } from "./suppressions-routes";
import { previewSchema, sendTemplateSchema, templateSchema, templateUpdateSchema, variableSchema } from "./templates";
import { devTemplateRoutes, listQuery as templateListQuery } from "./templates-routes";
import { createWebhookSchema, DELIVERY_STATUSES, rotateSchema as webhookRotateSchema, updateWebhookSchema, WEBHOOK_EVENTS } from "./webhooks";
import { deliveriesQuery, devWebhookRoutes } from "./webhooks-routes";

/**
 * The /dev/v1 OpenAPI 3.1 document. Request schemas are the routes' own Zod
 * schemas; responses mirror what the handlers return. `pnpm --filter
 * @boxox/mail generate` writes it to docs/api/openapi.json, and the SDK's
 * types are generated from that file.
 */

/** Where index.ts mounts each router; used to check every route is documented. */
export const DEV_MOUNTS = {
  "/dev/v1/templates": devTemplateRoutes,
  "/dev/v1/keys": devKeyRoutes,
  "/dev/v1/messages": devMessageRoutes,
  "/dev/v1/webhooks": devWebhookRoutes,
  "/dev/v1/received": devReceivedRoutes,
  "/dev/v1/suppressions": devSuppressionRoutes,
} as const;

const iso = z.string().datetime();
const isoOrNull = iso.nullable();
const page = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item), nextCursor: z.string().nullable() });

const sendRequest = sendSchema.extend({
  subject: sendSchema.shape.subject.optional(),
  template: sendTemplateSchema.optional(),
  variables: z.record(z.unknown()).optional(),
});

const schemas = {
  Error: z.object({
    error: z.object({ code: z.string(), message: z.string(), param: z.string().optional() }),
  }),

  SendMessageRequest: sendRequest,
  BatchRequest: batchSchema.extend({ messages: z.array(sendRequest).min(1).max(100) }),
  RescheduleRequest: rescheduleSchema,
  QueuedMessage: z.object({ id: z.string(), status: z.enum(["queued", "scheduled", "failed"]), scheduledAt: isoOrNull }),
  BatchResult: z.object({
    data: z.array(z.object({ index: z.number().int(), id: z.string(), status: z.enum(["queued", "scheduled", "failed"]), scheduledAt: isoOrNull })),
    errors: z.array(z.object({ index: z.number().int(), code: z.string(), message: z.string(), param: z.string().optional() })),
  }),
  BatchRejected: z.object({
    error: z.object({ code: z.literal("batch_rejected"), message: z.string() }),
    errors: z.array(z.object({ index: z.number().int(), code: z.string(), message: z.string(), param: z.string().optional() })),
  }),
  MessageSummary: z.object({
    id: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    replyTo: z.array(z.string()),
    subject: z.string(),
    tags: z.record(z.string()),
    status: z.enum(LIST_STATUSES),
    scheduledAt: isoOrNull,
    sentMessageId: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: iso,
    updatedAt: iso,
  }),
  RescheduleResult: z.object({ id: z.string(), status: z.enum(["scheduled", "failed"]), scheduledAt: iso }),
  CancelResult: z.object({ id: z.string(), status: z.literal("canceled") }),

  DomainKey: z.object({
    id: z.string(),
    kind: z.enum(API_KEY_KINDS),
    name: z.string(),
    domainId: z.string().nullable(),
    parentKeyId: z.string().nullable(),
    display: z.string(),
    permissions: z.array(z.enum(DOMAIN_KEY_PERMISSIONS)),
    allowedFrom: z.array(z.string()),
    allowedRecipients: z.array(z.string()),
    ipAllowlist: z.array(z.string()),
    rateLimitPerMinute: z.number().int().nullable(),
    dailySendCap: z.number().int().nullable(),
    expiresAt: isoOrNull,
    revokedAt: isoOrNull,
    rotationEndsAt: isoOrNull,
    lastUsedAt: isoOrNull,
    lastUsedIp: z.string().nullable(),
    createdBy: z.string(),
    createdAt: iso,
  }),
  CreateKeyRequest: apiCreateSchema,
  RotateKeyRequest: keyRotateSchema.unwrap(),
  RevokeResult: z.object({ revoked: z.array(z.string()) }),

  TemplateVariable: variableSchema,
  CreateTemplateRequest: templateSchema,
  UpdateTemplateRequest: templateUpdateSchema,
  PreviewTemplateRequest: previewSchema,
  Template: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
    subject: z.string(),
    html: z.string().nullable(),
    text: z.string().nullable(),
    variables: z.array(variableSchema),
    createdBy: z.string(),
    createdAt: iso,
  }),
  TemplatePreview: z.object({ name: z.string(), version: z.number().int(), subject: z.string(), html: z.string().nullable(), text: z.string() }),
  TemplateDeleted: z.object({ name: z.string(), deleted: z.literal(true), versions: z.number().int() }),

  CreateWebhookRequest: createWebhookSchema,
  UpdateWebhookRequest: updateWebhookSchema,
  RotateWebhookRequest: webhookRotateSchema,
  Webhook: z.object({
    id: z.string(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    status: z.enum(["active", "disabled"]),
    consecutiveFailures: z.number().int(),
    disabledAt: isoOrNull,
    previousSecretExpiresAt: isoOrNull,
    createdAt: iso,
    updatedAt: iso,
  }),
  WebhookDeleted: z.object({ id: z.string(), deleted: z.literal(true) }),
  WebhookTestResult: z.object({ deliveryId: z.string().optional() }),
  WebhookDelivery: z.object({
    id: z.string(),
    webhookId: z.string(),
    eventId: z.string(),
    eventType: z.string(),
    status: z.enum(DELIVERY_STATUSES),
    attempts: z.number().int(),
    nextAttemptAt: isoOrNull,
    lastStatusCode: z.number().int().nullable(),
    deliveredAt: isoOrNull,
    createdAt: iso,
  }),
  AttemptLogEntry: z.object({
    at: iso,
    status: z.number().int().nullable(),
    error: z.string().optional(),
    durationMs: z.number(),
    replay: z.boolean().optional(),
  }),

  ReceivedEmail: z.object({
    id: z.string(),
    object: z.literal("received_email"),
    to: z.string(),
    from: z.object({ email: z.string(), name: z.string().optional() }),
    toEmails: z.array(z.string()),
    ccEmails: z.array(z.string()),
    subject: z.string(),
    snippet: z.string(),
    spam: z.boolean(),
    receivedAt: iso,
  }),
  ReceivedAttachment: z.object({
    id: z.string(),
    filename: z.string(),
    declaredType: z.string().nullable(),
    detectedType: z.string(),
    size: z.number().int(),
    risk: z.enum(ATTACHMENT_RISKS),
    contentId: z.string().nullable(),
    inline: z.boolean(),
  }),
  RawDownload: z.object({ url: z.string().url(), expiresAt: iso }),

  AddSuppressionRequest: addSuppressionSchema,
  Suppression: z.object({
    id: z.string(),
    object: z.literal("suppression"),
    email: z.string(),
    reason: z.enum(suppressions.reason.enumValues),
    detail: z.string().nullable(),
    createdAt: iso,
  }),
  SuppressionDeleted: z.object({ id: z.string(), object: z.literal("suppression"), email: z.string(), deleted: z.literal(true) }),

  WebhookEventType: z.enum([...WEBHOOK_EVENTS, "webhook.test"]),
} satisfies Record<string, z.ZodTypeAny>;

type SchemaName = keyof typeof schemas | "MessageDetail" | "DeliveryDetail" | "ReceivedEmailDetail" | "WebhookWithSecret" | "CreatedKey" | "WebhookEvent";

const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });
const pageOf = (name: SchemaName) => ({
  type: "object",
  properties: { data: { type: "array", items: ref(name) }, nextCursor: { type: ["string", "null"] } },
  required: ["data", "nextCursor"],
  additionalProperties: false,
});
const listOf = (name: SchemaName) => ({
  type: "object",
  properties: { data: { type: "array", items: ref(name) } },
  required: ["data"],
  additionalProperties: false,
});

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema: _s, ...out } = zodToJsonSchema(schema, { target: "jsonSchema2019-09", $refStrategy: "none" }) as Record<string, unknown>;
  return out;
}

/** Composed schemas: a base by reference plus the extra fields. */
const extended = (base: SchemaName, properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  allOf: [ref(base), { type: "object", properties, required }],
});

function componentSchemas() {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(schemas)) out[name] = jsonSchema(schema);
  out.MessageDetail = extended("MessageSummary", {
    timeline: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["queued", ...MESSAGE_EVENT_TYPES] },
          recipient: { type: ["string", "null"] },
          at: { type: "string", format: "date-time" },
          detail: { type: ["object", "null"], additionalProperties: true },
        },
        required: ["type", "recipient", "at", "detail"],
      },
    },
    body: {
      oneOf: [
        {
          type: "object",
          properties: {
            text: { type: "string" },
            html: { type: ["string", "null"] },
            headers: { type: "object", additionalProperties: { type: "string" } },
            attachments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  filename: { type: "string" },
                  contentType: { type: "string" },
                  contentId: { type: ["string", "null"] },
                  size: { type: "integer" },
                },
                required: ["filename", "contentType", "contentId", "size"],
              },
            },
          },
          required: ["text", "html", "headers", "attachments"],
        },
        { type: "null" },
      ],
    },
  });
  out.CreatedKey = {
    type: "object",
    description: "The full secret appears only in this response.",
    properties: { key: ref("DomainKey"), secret: { type: "string" } },
    required: ["key", "secret"],
  };
  out.WebhookWithSecret = extended("Webhook", { secret: { type: "string", description: "whsec_… signing secret; shown only on create and rotate." } });
  out.DeliveryDetail = extended("WebhookDelivery", {
    attemptLog: { type: "array", items: ref("AttemptLogEntry") },
    payload: {},
  });
  out.ReceivedEmailDetail = extended("ReceivedEmail", {
    messageId: { type: ["string", "null"] },
    inReplyTo: { type: ["string", "null"] },
    references: { type: ["string", "null"] },
    authentication: { type: "object", properties: { authenticated: { type: "boolean" } }, required: ["authenticated"] },
    text: { type: ["string", "null"] },
    html: { type: ["string", "null"] },
    attachments: { type: "array", items: ref("ReceivedAttachment") },
    hasRaw: { type: "boolean" },
  });
  out.WebhookListenFrame = {
    type: "object",
    description: "One event sent to `GET /dev/v1/webhooks/listen`. `payload` is the WebhookEvent JSON exactly as an endpoint would receive it.",
    properties: { id: { type: "string" }, payload: { type: "string" } },
    required: ["id", "payload"],
  };
  out.WebhookEvent = {
    type: "object",
    description: "The signed JSON body POSTed to a webhook endpoint (Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature).",
    properties: {
      type: ref("WebhookEventType"),
      timestamp: { type: "string", format: "date-time" },
      data: { type: "object", additionalProperties: true },
    },
    required: ["type", "timestamp", "data"],
  };
  return out;
}

type Param = { name: string; in: "path" | "query" | "header"; required: boolean; schema: unknown; description?: string };

const pathParam = (name: string): Param => ({ name, in: "path", required: true, schema: { type: "string" } });

function queryParams(schema: z.AnyZodObject): Param[] {
  return Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([name, field]) => ({
    name,
    in: "query",
    required: !field.isOptional(),
    schema: jsonSchema(field instanceof z.ZodOptional ? field.unwrap() : field),
  }));
}

const idempotencyHeader: Param = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 255 },
  description: "Replays within 24 h return the original response; a different body gets 409.",
};

const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
const errorResponse = (description: string) => ({ description, ...json(ref("Error")) });

const COMMON_ERRORS = {
  BadRequest: errorResponse("Invalid request"),
  Unauthorized: errorResponse("Missing or invalid API key"),
  Forbidden: errorResponse("The key may not do this"),
  NotFound: errorResponse("Not found on this key's domain"),
};
const commonErrorRefs = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
};

interface Op {
  operationId: string;
  summary: string;
  tag: string;
  params?: Param[];
  body?: SchemaName;
  bodyRequired?: boolean;
  responses: Record<string, unknown>;
  public?: boolean;
}

const ok = (status: string, schema: unknown, description = "OK") => ({ [status]: { description, ...json(schema) } });

/** Every documented route, keyed by "METHOD /full/path" in Hono's `:param` form. */
const OPERATIONS: Record<string, Op> = {
  "POST /dev/v1/messages": {
    operationId: "sendMessage",
    summary: "Send or schedule one message (needs `send`)",
    tag: "messages",
    params: [idempotencyHeader],
    body: "SendMessageRequest",
    bodyRequired: true,
    responses: { ...ok("202", ref("QueuedMessage"), "Queued or scheduled"), "409": errorResponse("Idempotency-Key conflict"), "422": errorResponse("Rejected"), "429": errorResponse("Rate limit or daily cap reached") },
  },
  "POST /dev/v1/messages/batch": {
    operationId: "sendBatch",
    summary: "Send up to 100 messages, all-or-nothing or partial (needs `send`)",
    tag: "messages",
    params: [idempotencyHeader],
    body: "BatchRequest",
    bodyRequired: true,
    responses: {
      ...ok("202", ref("BatchResult"), "Queued; `errors` lists skipped messages in partial mode"),
      "409": errorResponse("Idempotency-Key conflict"),
      "422": { description: "No message was sent", ...json(ref("BatchRejected")) },
      "429": errorResponse("Rate limit or daily cap reached"),
    },
  },
  "GET /dev/v1/messages": {
    operationId: "listMessages",
    summary: "Message log, newest first (needs `read_log`)",
    tag: "messages",
    params: queryParams(messageListQuery),
    responses: ok("200", pageOf("MessageSummary")),
  },
  "GET /dev/v1/messages/:id": {
    operationId: "getMessage",
    summary: "One message with its status timeline and rendered body (needs `read_log`)",
    tag: "messages",
    params: [pathParam("id")],
    responses: ok("200", ref("MessageDetail")),
  },
  "PATCH /dev/v1/messages/:id": {
    operationId: "rescheduleMessage",
    summary: "Move a scheduled message's send time (needs `send`)",
    tag: "messages",
    params: [pathParam("id")],
    body: "RescheduleRequest",
    bodyRequired: true,
    responses: { ...ok("200", ref("RescheduleResult")), "409": errorResponse("Not scheduled any more") },
  },
  "POST /dev/v1/messages/:id/cancel": {
    operationId: "cancelMessage",
    summary: "Cancel a scheduled message (needs `send`)",
    tag: "messages",
    params: [pathParam("id")],
    responses: { ...ok("200", ref("CancelResult")), "409": errorResponse("Not scheduled any more") },
  },

  "GET /dev/v1/keys": {
    operationId: "listKeys",
    summary: "Domain keys on the management key's domains",
    tag: "keys",
    responses: ok("200", listOf("DomainKey")),
  },
  "POST /dev/v1/keys": {
    operationId: "createKey",
    summary: "Create a domain key (management keys only)",
    tag: "keys",
    body: "CreateKeyRequest",
    bodyRequired: true,
    responses: ok("201", ref("CreatedKey"), "Created; the secret is shown once"),
  },
  "POST /dev/v1/keys/:id/rotate": {
    operationId: "rotateKey",
    summary: "Issue a new secret; the old one works for the overlap window",
    tag: "keys",
    params: [pathParam("id")],
    body: "RotateKeyRequest",
    responses: ok("200", ref("CreatedKey")),
  },
  "POST /dev/v1/keys/:id/revoke": {
    operationId: "revokeKey",
    summary: "Revoke a domain key at once",
    tag: "keys",
    params: [pathParam("id")],
    responses: ok("200", ref("RevokeResult")),
  },

  "GET /dev/v1/templates": {
    operationId: "listTemplates",
    summary: "Latest version of each template (needs `templates`)",
    tag: "templates",
    params: queryParams(templateListQuery),
    responses: ok("200", pageOf("Template")),
  },
  "POST /dev/v1/templates": {
    operationId: "createTemplate",
    summary: "Create a template at version 1",
    tag: "templates",
    body: "CreateTemplateRequest",
    bodyRequired: true,
    responses: { ...ok("201", ref("Template"), "Created"), "409": errorResponse("A template with this name exists") },
  },
  "GET /dev/v1/templates/:name": {
    operationId: "getTemplate",
    summary: "The latest version, or ?version=",
    tag: "templates",
    params: [pathParam("name"), { name: "version", in: "query", required: false, schema: { type: "integer", minimum: 1 } }],
    responses: ok("200", ref("Template")),
  },
  "GET /dev/v1/templates/:name/versions": {
    operationId: "listTemplateVersions",
    summary: "Every version, newest first",
    tag: "templates",
    params: [pathParam("name")],
    responses: ok("200", listOf("Template")),
  },
  "PUT /dev/v1/templates/:name": {
    operationId: "updateTemplate",
    summary: "Save a new version",
    tag: "templates",
    params: [pathParam("name")],
    body: "UpdateTemplateRequest",
    bodyRequired: true,
    responses: ok("200", ref("Template")),
  },
  "POST /dev/v1/templates/:name/preview": {
    operationId: "previewTemplate",
    summary: "Render with sample variables",
    tag: "templates",
    params: [pathParam("name")],
    body: "PreviewTemplateRequest",
    responses: ok("200", ref("TemplatePreview")),
  },
  "DELETE /dev/v1/templates/:name": {
    operationId: "deleteTemplate",
    summary: "Delete every version",
    tag: "templates",
    params: [pathParam("name")],
    responses: ok("200", ref("TemplateDeleted")),
  },

  "POST /dev/v1/webhooks": {
    operationId: "createWebhook",
    summary: "Add an HTTPS endpoint (needs `webhooks`)",
    tag: "webhooks",
    body: "CreateWebhookRequest",
    bodyRequired: true,
    responses: { ...ok("201", ref("WebhookWithSecret"), "Created; the secret is shown once"), "422": errorResponse("URL not allowed") },
  },
  "GET /dev/v1/webhooks": {
    operationId: "listWebhooks",
    summary: "Endpoints on the key's domain",
    tag: "webhooks",
    responses: ok("200", listOf("Webhook")),
  },
  "GET /dev/v1/webhooks/listen": {
    operationId: "listenWebhooks",
    summary: "Live events on the key's domain over a WebSocket, for local development",
    tag: "webhooks",
    responses: {
      "101": { description: "Switching protocols; each text frame is a WebhookListenFrame" },
      "426": errorResponse("Not a WebSocket upgrade"),
    },
  },
  "GET /dev/v1/webhooks/:id": {
    operationId: "getWebhook",
    summary: "One endpoint",
    tag: "webhooks",
    params: [pathParam("id")],
    responses: ok("200", ref("Webhook")),
  },
  "PATCH /dev/v1/webhooks/:id": {
    operationId: "updateWebhook",
    summary: "Change the URL or events, or enable/disable",
    tag: "webhooks",
    params: [pathParam("id")],
    body: "UpdateWebhookRequest",
    bodyRequired: true,
    responses: { ...ok("200", ref("Webhook")), "422": errorResponse("URL not allowed") },
  },
  "DELETE /dev/v1/webhooks/:id": {
    operationId: "deleteWebhook",
    summary: "Delete an endpoint",
    tag: "webhooks",
    params: [pathParam("id")],
    responses: ok("200", ref("WebhookDeleted")),
  },
  "POST /dev/v1/webhooks/:id/rotate": {
    operationId: "rotateWebhookSecret",
    summary: "New signing secret; both sign during the overlap",
    tag: "webhooks",
    params: [pathParam("id")],
    body: "RotateWebhookRequest",
    responses: ok("200", ref("WebhookWithSecret")),
  },
  "POST /dev/v1/webhooks/:id/test": {
    operationId: "testWebhook",
    summary: "Send a webhook.test event",
    tag: "webhooks",
    params: [pathParam("id")],
    responses: { ...ok("202", ref("WebhookTestResult"), "Queued"), "409": errorResponse("Webhook disabled") },
  },
  "GET /dev/v1/webhooks/:id/deliveries": {
    operationId: "listWebhookDeliveries",
    summary: "Delivery log, newest first",
    tag: "webhooks",
    params: [pathParam("id"), ...queryParams(deliveriesQuery)],
    responses: ok("200", pageOf("WebhookDelivery")),
  },
  "GET /dev/v1/webhooks/:id/deliveries/:deliveryId": {
    operationId: "getWebhookDelivery",
    summary: "One delivery with its attempt log and payload",
    tag: "webhooks",
    params: [pathParam("id"), pathParam("deliveryId")],
    responses: ok("200", ref("DeliveryDetail")),
  },
  "POST /dev/v1/webhooks/:id/deliveries/:deliveryId/replay": {
    operationId: "replayWebhookDelivery",
    summary: "Send a finished delivery again",
    tag: "webhooks",
    params: [pathParam("id"), pathParam("deliveryId")],
    responses: { ...ok("202", ref("WebhookDelivery"), "Queued"), "409": errorResponse("Disabled or still pending") },
  },

  "GET /dev/v1/received": {
    operationId: "listReceived",
    summary: "Mail received on the domain's app inboxes (needs `read_received`)",
    tag: "received",
    params: queryParams(receivedListQuery),
    responses: ok("200", pageOf("ReceivedEmail")),
  },
  "GET /dev/v1/received/:id": {
    operationId: "getReceived",
    summary: "Parsed fields, authentication, bodies and attachments",
    tag: "received",
    params: [pathParam("id")],
    responses: ok("200", ref("ReceivedEmailDetail")),
  },
  "GET /dev/v1/received/:id/raw": {
    operationId: "getReceivedRawUrl",
    summary: "A signed, expiring link to the original .eml",
    tag: "received",
    params: [pathParam("id"), ...queryParams(rawQuery)],
    responses: { ...ok("200", ref("RawDownload")), "409": errorResponse("Raw downloads are not configured") },
  },
  "GET /dev/v1/received/:id/attachments/:attachmentId": {
    operationId: "getReceivedAttachment",
    summary: "Download one attachment",
    tag: "received",
    params: [pathParam("id"), pathParam("attachmentId")],
    responses: { "200": { description: "The attachment bytes", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } },
  },
  "GET /dev/v1/received/raw/:token": {
    operationId: "downloadReceivedRaw",
    summary: "The signed .eml link itself; no API key, the token is the credential",
    tag: "received",
    public: true,
    params: [pathParam("token")],
    responses: {
      "200": { description: "The original message", content: { "message/rfc822": { schema: { type: "string", format: "binary" } } } },
      "404": errorResponse("Invalid or expired link"),
    },
  },

  "GET /dev/v1/suppressions": {
    operationId: "listSuppressions",
    summary: "The domain's suppression list (needs `read_log`)",
    tag: "suppressions",
    params: queryParams(suppressionListQuery),
    responses: ok("200", pageOf("Suppression")),
  },
  "GET /dev/v1/suppressions/:email": {
    operationId: "getSuppression",
    summary: "Whether one address is suppressed",
    tag: "suppressions",
    params: [pathParam("email")],
    responses: ok("200", ref("Suppression")),
  },
  "POST /dev/v1/suppressions": {
    operationId: "addSuppression",
    summary: "Suppress an address (needs `send`)",
    tag: "suppressions",
    body: "AddSuppressionRequest",
    bodyRequired: true,
    responses: ok("201", ref("Suppression"), "Suppressed"),
  },
  "DELETE /dev/v1/suppressions/:email": {
    operationId: "removeSuppression",
    summary: "Remove an address from our list (Cloudflare's still applies)",
    tag: "suppressions",
    params: [pathParam("email")],
    responses: ok("200", ref("SuppressionDeleted")),
  },
};

/** "METHOD /full/path" for every handler mounted under /dev/v1. */
export function mountedRoutes(): string[] {
  const out = new Set<string>();
  for (const [prefix, router] of Object.entries(DEV_MOUNTS)) {
    for (const r of (router as { routes: { method: string; path: string }[] }).routes) {
      if (r.method === "ALL") continue;
      out.add(`${r.method} ${prefix}${r.path === "/" ? "" : r.path}`);
    }
  }
  return [...out].sort();
}

export function documentedRoutes(): string[] {
  return Object.keys(OPERATIONS).sort();
}

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, "{$1}");

export function openapiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [route, op] of Object.entries(OPERATIONS)) {
    const [method, path] = route.split(" ") as [string, string];
    const responses = op.public ? op.responses : { ...commonErrorRefs, ...op.responses };
    (paths[toOpenApiPath(path)] ??= {})[method.toLowerCase()] = {
      operationId: op.operationId,
      summary: op.summary,
      tags: [op.tag],
      ...(op.public ? { security: [] } : {}),
      ...(op.params?.length ? { parameters: op.params } : {}),
      ...(op.body ? { requestBody: { required: !!op.bodyRequired, ...json(ref(op.body)) } } : {}),
      responses: Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Box Ox developer API",
      version: "1.0.0",
      description:
        "Send, schedule and log mail, manage templates, webhooks, received mail and suppressions for one domain. Errors are `{error:{code,message,param?}}`. Lists use cursor pagination (`nextCursor`).",
    },
    servers: [{ url: "{baseUrl}", variables: { baseUrl: { default: "https://mail.example.com" } } }],
    security: [{ apiKey: [] }],
    tags: ["messages", "keys", "templates", "webhooks", "received", "suppressions"].map((name) => ({ name })),
    paths,
    webhooks: {
      event: {
        post: {
          summary: "An event delivered to your endpoint, signed with the endpoint's whsec_ secret",
          requestBody: { required: true, ...json(ref("WebhookEvent")) },
          responses: { "200": { description: "Any 2xx acknowledges the delivery" } },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "A domain key (bxk_…) for mail routes, or a management key (bxm_…) for /dev/v1/keys.",
        },
      },
      responses: COMMON_ERRORS,
      schemas: componentSchemas(),
    },
  };
}

let cached: ReturnType<typeof openapiDocument> | undefined;

/** GET /dev/v1/openapi.json: the published spec. No key needed. */
export const devOpenApiRoutes = new Hono().get("/", (c) => c.json((cached ??= openapiDocument())));
