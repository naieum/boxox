---
name: boxox-email
description: Create and review Box Ox email templates, add transactional sending and verified webhooks, or migrate a Resend integration to the Box Ox SDK and CLI. Use for application email integration; infrastructure setup belongs to the Box Ox setup wizard or Wrangler.
metadata:
  version: 0.4.0
---

Use the existing Box Ox install, the `@boxox/mail` SDK, and the `boxox` CLI. Download `https://boxox.dev/downloads/boxox-cli-0.2.0.tgz`, verify it against `https://boxox.dev/downloads/SHA256SUMS.txt`, and install the local tarball with the project's package manager if the CLI is missing; invoke its `boxox` binary through that package manager when installed locally. The SDK is the API contract; avoid hand-written HTTP calls to the developer API.

## Establish credentials and scope

Find the project's sending domain and Box Ox origin from its existing configuration. If no management credential is available, ask the owner to create a management key in Developer → Keys for that domain. Management keys begin `bxm_`; domain keys begin `bxk_`. A management key cannot send mail and cannot create another management key. Do not request Cloudflare account credentials to integrate application email.

For an interactive login, use the OS keychain:

```sh
boxox login --url https://mail.example.com --key -
```

Provide the key through standard input. The config stores only the origin. On a machine without a working OS keychain, provide `BOXOX_URL` and `BOXOX_KEY` through the user's secret manager or environment. Never put real secrets in source, command output shared with others, or checked-in files.

Start with a send-only project key:

```sh
boxox keys create --domain app.example.com --name project-mail --perm send
```

The JSON response contains `secret` once. Capture it into the project's secret store; don't repeat it in the final report. Add `read_log`, `templates`, `webhooks`, or `read_received` only for features the project actually needs. A separate operator key can manage templates/webhooks and inspect logs without giving the application's sending process those capabilities. Keep the management key out of application deployments.

## Add sending and configuration

Download `https://boxox.dev/downloads/boxox-mail-0.2.0.tgz`, verify its SHA-256, then install the local tarball using the project's existing package manager (for example, `npm install ./boxox-mail-0.2.0.tgz`). Packages are self-published on boxox.dev; do not resolve them from the npm registry. Configure `BOXOX_URL` with the Box Ox origin and `BOXOX_KEY` with the project domain key. For Workers, install these as secrets with `wrangler secret put BOXOX_KEY` and the appropriate URL configuration. Store `BOXOX_WEBHOOK_SECRET` separately when adding a webhook. Do not write credentials to a committed `.env` file.

Use [assets/send-email.mjs](assets/send-email.mjs) as the small send-helper starting point. It exports `sendEmail`, accepts the SDK client's environment explicitly, and supports an idempotency key. The key's domain must match the From address. Keep HTML escaping in the renderer or Box Ox template; don't interpolate untrusted text into HTML.

```sh
boxox send --from hello@app.example.com --to recipient@example.net --subject 'Integration check' --text 'Box Ox integration check' --idempotency-key integration-check-1
boxox messages list --limit 10
boxox messages get MESSAGE_ID
```

Send only to a recipient the user has authorized. Preserve each business operation's stable idempotency key when retrying. A queued result proves acceptance, not delivery; inspect the message timeline or a delivered event for delivery confirmation. Management keys cannot read message logs.

## Create or revise a template

Before authoring, read [references/email-design.md](references/email-design.md). Apply its review to every new or changed template. Use [assets/invoice-template.json](assets/invoice-template.json) as a portable HTML-and-text example; adapt its language, purpose, fields, and design to the project.

Keep a JSON file with `name`, `subject`, explicit `html`/`text`, and declared `variables`. Review both parts locally with representative rendered values before `boxox templates push FILE`. After pushing, use `boxox templates preview NAME --variables '{"name":"Ada"}'` with that template's actual variables. `templates pull NAME --out FILE` produces the same portable format.

The local review gates publishing. The server preview then confirms variable rendering before an authorized test send. In your handoff, record images-off readability, HTML/text fact and link agreement, and summary/next-action review. Report target-client checks as passed or not run. Do not claim checks you could not perform. Box Ox can derive text when omitted, but template agents must supply and review it explicitly.

## Add a verified webhook

Use [assets/webhook-route.mjs](assets/webhook-route.mjs) for a fetch-style handler. It passes the untouched request bytes and the Standard Webhooks headers to `verifyWebhookRequest`, returning 400 before business logic when authentication fails. Adapt the exported handler to the framework's route convention. Keep the request body raw until verification. Deduplicate accepted events by `webhook-id` in durable application storage before applying business effects, and return 2xx only after the event is safely recorded.

Register the deployed HTTPS route with an operator key holding `webhooks`:

```sh
boxox webhooks create --url https://app.example.com/webhooks/boxox --event message.delivered --event message.bounced
boxox webhooks test WEBHOOK_ID
boxox doctor --webhook WEBHOOK_ID
```

Capture the returned `secret` as `BOXOX_WEBHOOK_SECRET`. The test command queues a delivery; inspect its delivery result in Box Ox to confirm remote reachability. Doctor reports authenticated API capabilities and permission-limited probes, and links `/setup` for DNS and Email Sending checks. It never provisions infrastructure.

For local development, use a temporary local signing secret beginning `whsec_` with base64 key bytes:

```sh
boxox webhooks listen --forward-to http://localhost:3000/webhooks/boxox --secret "$BOXOX_WEBHOOK_SECRET"
```

The authenticated MailboxHub stream is domain-scoped. The CLI signs forwarded events with the supplied local secret so the application's normal signature verification stays enabled. This is a development signature, not proof of a production delivery's original signature. Restart the listener after a connection loss; inspect the message log for events missed during the disconnection.

## Migrate from Resend

Inventory send sites, templates, webhook event handlers, environment variables, and retry/idempotency behavior before editing. Replace the provider SDK with `@boxox/mail`, then map the existing behavior:

| Existing concept | Box Ox mapping |
| --- | --- |
| API key / base URL | Domain-scoped `BOXOX_KEY` / `BOXOX_URL` |
| Send email | `new BoxOx({ key, url }).messages.send(body, { idempotencyKey })` |
| From, To, Cc, Bcc, Reply-To | `from`, `to`, `cc`, `bcc`, `replyTo` |
| HTML and plain text | `html` and `text` |
| Named template | `template: { name, version? }` and `variables` |
| Delivery/bounce notification | `message.delivered` / `message.bounced`; verify the Box Ox signature |
| Provider request ID | The returned Box Ox message `id`; update stored references and log links |

Re-point the webhook URL and signing secret together. Keep business deduplication across the transition. Verify a successful send, invalid-signature rejection, and an accepted verified event before removing the old integration. The SDK's TypeScript request types are authoritative for attachments, tags, scheduling, and other optional fields.

## Local verification

From this repository root run:

```sh
bash skills/boxox-email/e2e.sh --local
```

The script starts an isolated Wrangler worker with production developer routes, D1, R2, and MailboxHub. It creates least-permission keys, runs the documented CLI commands, copies both helper assets into a temporary sample project, sends through the SDK, and verifies a signed event at a real localhost route. Email transport and the external queue are stubbed: this checks the integration contract without sending external mail. It deletes its sample directory and stops Wrangler on completion. Actual inbox arrival and deployed webhook reachability require the owner's configured install and an authorized recipient.
