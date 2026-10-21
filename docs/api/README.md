# Box Ox developer API

`openapi.json` is the OpenAPI 3.1 spec for `/dev/v1/*`. A running install also serves it at `GET /dev/v1/openapi.json`. This endpoint needs no key.

The Free inbox profile supports incoming-mail access and webhooks. Outbound requests return `feature_unavailable`.

## Direct SDK and CLI downloads

Box Ox self-publishes packages at https://boxox.dev/downloads/#developer-tools. Use the downloaded packages directly.
Download `boxox-mail-0.2.0.tgz`, verify it against the published SHA256SUMS.txt, then run `npm install ./boxox-mail-0.2.0.tgz` (or the equivalent in your package manager).

The installed package name is `@boxox/mail`. The imports in this guide stay the same.
The CLI package `boxox-cli-0.2.0.tgz` bundles the SDK and WebSocket client. Install the local file or run the standalone `boxox-cli-0.2.0.mjs` with Node.js 22+.

Successful API sends appear in Sent and Developer logs. A received reply brings the conversation into Inbox. Mailbox copies have separate storage. Deleting one does not remove the API log.

A copy binds to an existing matching sender mailbox and follows its read grants. Without that mailbox, only the installation owner can read the copy.


## Keys

Send `Authorization: Bearer <key>`.

- A **domain key** (`bxk_…`) acts on exactly one domain, within its permissions: `send`, `read_log`, `read_received`, `templates`, `webhooks`.
- A **management key** (`bxm_…`) can only use `/dev/v1/keys`. It mints, lists, rotates and revokes domain keys on its own domains.

## Errors and pagination

Every error has the form `{"error": {"code", "message", "param"?}}`. A rejected batch also returns `errors: [{index, code, message, param?}]`.

Lists return `{data, nextCursor}`. To get the next page, pass `nextCursor` back as `?cursor=`. `nextCursor` is `null` on the last page.

## SDK

```ts
import { BoxOx } from "@boxox/mail";

const mail = new BoxOx({ key: process.env.BOXOX_KEY, url: process.env.BOXOX_URL });

const { id } = await mail.messages.send(
  { from: "noreply@app1.com", to: "user@example.com", template: "welcome", variables: { name: "Ada" } },
  { idempotencyKey: "signup-123" },
);

for await (const m of mail.paginate(mail.messages.list, { status: "bounced" })) console.log(m.id);
```

`mail.request(operationId, {path, query, body})` calls any operation in the spec by its `operationId`.

## Webhooks

Box Ox signs deliveries in the [Standard Webhooks](https://www.standardwebhooks.com/) format. Each delivery carries three headers: `webhook-id`, `webhook-timestamp` and `webhook-signature`. The signature is `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`. During a secret rotation the header holds two space-separated signatures, one per secret.

To verify a delivery, pass the raw body, before any JSON parsing:

```ts
import { verifyWebhookRequest, WebhookVerificationError } from "@boxox/mail/webhooks";

export default {
  async fetch(request: Request, env: { BOXOX_WEBHOOK_SECRET: string }) {
    try {
      const event = await verifyWebhookRequest(request, env.BOXOX_WEBHOOK_SECRET);
      if (event.type === "message.received") {
        // event.data is a ReceivedEmail
      }
      return new Response(null, { status: 204 });
    } catch (err) {
      if (err instanceof WebhookVerificationError) return new Response("bad signature", { status: 401 });
      throw err;
    }
  },
};
```

By default, the verifier rejects a timestamp more than 5 minutes from now. Change the limit with `toleranceSeconds`.

Several deliveries can carry the same `webhook-id`, for example a replay. Use it to deduplicate.

## Template design

Template agents must complete the [email design review](https://boxox.dev/docs/email-design/) before publishing. The current [email skill](https://boxox.dev/downloads/boxox-email-skill-0.4.0.zip) includes the review and an HTML/plain-text invoice example.

## Maintain the API contract

1. The routes in `apps/worker/src/dev/*-routes.ts` validate with Zod.
2. `apps/worker/src/dev/openapi.ts` builds the spec from those same schemas, plus the response shapes.
3. `pnpm --filter @boxox/mail generate` writes `docs/api/openapi.json` and the SDK types in `packages/sdk/src/schema.ts`.
4. Run `pnpm --filter @boxox/mail run check-openapi` to check freshness, route coverage, and SDK types.

The check fails if either generated file is out of date. It also fails for a missing mounted `/dev/v1` route or incompatible SDK types.

Do not edit `openapi.json` or `schema.ts` by hand. Change the route or `openapi.ts`, then run `generate`.
