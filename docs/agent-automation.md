# Agent mail workflows

Use the changes feed to discover mail. Use work claims to coordinate processing. Fetch bodies only when needed.

Agent endpoints require a short-lived agent bearer and the mailbox’s `read` grant. Developer `bxk_` and `bxm_` keys do not work here. The owner pairs agents and controls grants in the app.

## Request MCP access before connecting

Agree on the exact mailbox addresses and permissions before opening OAuth consent. Each requested mailbox permission is an OAuth scope in the form `boxox:<permission>:<email>`. For example, `boxox:read:hello@example.com` requests reading that mailbox. Add `boxox:send:hello@example.com` only when replies are needed. `send_new` also permits new recipients; request it only for that task. `webhook` and `classify` are separate permissions.

CLI 0.3.0 prepares the request without credentials or a connection:

```sh
boxox mcp request --url https://mail.example.com --mailbox hello@example.com --mailbox ian@example.com --perm read
```

Its JSON output lists the requested mailboxes, OAuth scopes, endpoint, and client login arguments. Each `--perm` applies to every listed mailbox. For different rights per mailbox, use `--grant read:hello@example.com --grant send:hello@example.com --grant read:ian@example.com` instead of `--mailbox` and `--perm`. Preparing the request does not grant access.

Configure the remote MCP server URL as `https://<your-installation>/mcp`. In Codex, once the server is configured as `boxox`, pass the agreed scopes at login:

```sh
codex mcp login boxox --scopes 'boxox:read:hello@example.com,boxox:read:ian@example.com'
```

The client sends these as space-separated values in the authorization request's `scope` parameter. The consent screen lists only the requested mailboxes and permissions. The owner approves or denies that request; they do not have to construct it from every available permission. Box Ox checks the request again when saving approval and rejects added mailboxes, added permissions, and broader existing agents. Unknown or inactive mailboxes fail before approval.

Clients that send no mailbox scopes get a collapsed manual setup option. Nothing is selected for them. Prefer a specific request so the owner can review the access the agent needs. Existing agent tokens and their grants continue to work.

After approval, call `list_addresses` to verify the actual granted mailbox IDs and permissions before reading or sending. If the required mailbox is missing, reconnect with a corrected request. Do not switch to another email account without explaining the missing mailbox access.

## Process pending mail

Build the SDK and CLI from the same source release as your Worker. Earlier SDK packages expose only the developer API.

```ts
import { BoxOxAgent } from '@boxox/mail';

const agent = new BoxOxAgent({
  url: process.env.BOXOX_URL,
  token: process.env.BOXOX_AGENT_TOKEN,
});
const group = 'support';
const page = await agent.work.pending(addressId, { group, limit: 50 });

for (const item of page.messages) {
  const claim = await agent.work.claim({ messageId: item.messageId, group });
  const ref = { messageId: item.messageId, claimToken: claim.claimToken, group };
  const { message } = await agent.message(item.messageId, { includeBody: true });
  await handle(message); // Your processing function. Make external actions idempotent.
  await agent.work.complete(ref);
}
```

Follow `page.nextCursor` to drain a pending list. Another worker can win a claim first. On `409 work_unavailable`, skip that message. Claims provide at-least-once processing, not exactly-once external actions.

If processing fails safely, call `agent.work.retry({ ...ref, delaySeconds: 30 })`. For longer work, call `agent.work.renew({ ...ref, leaseSeconds: 300 })` before expiry. A lost claim returns `409 claim_lost`.

## Save a recovery checkpoint

1. Call `agent.changes(addressId, { cursor: savedCursor, limit: 100 })`.
2. Process the page or persist its work in your own durable queue.
3. Save `nextCursor` only after that succeeds, including for an empty page.
4. If `hasMore` is true, request the next page immediately.

If `hasMore` is false, wait for a webhook or your next scheduled poll. Empty pages require no model call.

The first request can omit `cursor`. Upgrading an existing mailbox creates initial thread events. Webhooks can wake the agent. The journal recovers changes after a disconnect.

A feed checkpoint records discovery, not completed work. Pending-list cursors only page the current pending list. Do not use them as recovery checkpoints. Restart the pending list after draining it to discover delayed retries and expired claims.

## REST and MCP reference

REST paths below start with `/api/agent/v1`. Send `Authorization: Bearer <agent-token>`. GET options are query parameters. POST options are JSON fields.

| Operation | REST | MCP tool | Main options |
|---|---|---|---|
| Changes | GET `/addresses/:addressId/changes` | `list_changes` | `addressId`, `cursor`, `limit` |
| Threads | GET `/addresses/:addressId/threads` | `list_threads` | `addressId`, `cursor`, `limit` |
| Thread messages | GET `/threads/:threadId` | `get_thread` | `threadId`, `cursor`, `limit`, `includeBody` |
| One message | GET `/messages/:messageId` | `get_message` | `messageId`, `includeBody` |
| Pending work | GET `/addresses/:addressId/work` | `list_work` | `addressId`, `group`, `cursor`, `limit` |
| Claim | POST `/work/claim` | `claim_message` | `messageId`, `group`, `leaseSeconds` |
| Complete | POST `/work/complete` | `complete_message` | `messageId`, `group`, `claimToken` |
| Renew | POST `/work/renew` | `renew_claim` | Claim reference plus `leaseSeconds` |
| Retry | POST `/work/retry` | `retry_message` | Claim reference plus `delaySeconds` |
| Complete batch | POST `/work/complete-batch` | `complete_messages` | `items`: 1–10 claim references |

MCP accepts IDs as arguments rather than path parameters. Each batch result reports success or an error. A failed item does not undo successful completions.

## Bounds and claim ownership

| Setting | Default | Maximum |
|---|---|---|
| Metadata page | 50 items | 100 items |
| Thread page with bodies | 10 messages | 10 messages |
| Text per message | Metadata only | 32,768 characters when requested |
| Body object read | None by default | 2 MiB stored JSON object |
| Claim lease | 300 seconds | 3,600 seconds |
| Retry delay | 30 seconds | 86,400 seconds, or 0 for immediate retry |
| Completion batch | No default | 10 references |

Omit `group` for work private to one agent. Use the same group across workers to coordinate claims. Group names accept 1–64 letters, digits, dots, underscores, and hyphens. The first character must be a letter or digit.

Only the claiming agent can complete, renew, or retry its active lease. Keep the token private. Renewal preserves the token. Reclaiming expired work replaces it. Completion remains terminal for that consumer and repeats safely with the same agent and token.

Work state does not change read/unread or mail folders. Pending work includes inbound messages, excluding Trash. It waits until all inbound messages in the thread finish safety processing.

## Read compatibility and visibility

`get_thread` and REST thread reads now return paginated metadata by default. **Clients that need text must pass `includeBody: true` and follow `nextCursor`.** One-message reads also require that option for text.

Check `bodyTruncated` and `bodyUnavailable`. These APIs do not download attachments or full oversized bodies. Optional enrichment does not block mail after required checks finish.

Without `classify`, agents cannot see Spam, Quarantine, or threads flagged for prompt injection. Even classifier agents cannot read or claim threads with pending inbound safety checks. `unscanned` identifies the existing local-check fallback after an AI error and remains eligible.

Replay applies current grants and visibility. It does not preserve an old view of hidden mail. If `classify` changes, the feed returns `400 cursor_permissions_changed`. Restart without a cursor and deduplicate replayed work. A journal reset after restoring a backup can also require a new checkpoint.

## Reply retries

The inbox install on Cloudflare Workers Free does not send mail. These reply operations require the full install on Workers Paid and sending grants.

Use a stable `idempotencyKey` with `agent.send()` or MCP `send_email`. REST also accepts the `Idempotency-Key` header. Header and body values must agree.

Box Ox associates each key with one agent by default. For shared workers, set `idempotencyGroup` to the work group and provide an `idempotencyKey`. Shared keys use that sending address and group. Every caller still needs current sending permission. Keys do not expire automatically.

Reusing a key with different content returns `409 idempotency_conflict`. An unresolved send returns `409 send_state_unknown`. Review its saved outcome before taking further action. Do not create a new key to bypass that state.

```ts
await agent.send({
  fromAddressId: addressId,
  to: ['customer@example.com'],
  threadId: messageThreadId,
  subject: 'Re: Your request',
  text: 'Your request is complete.',
  idempotencyGroup: 'support',
  idempotencyKey: `reply:${messageId}`,
});
```

Use stable keys for other external actions too. Work claims alone cannot make those actions execute exactly once.

## CLI

Set `BOXOX_URL` and `BOXOX_AGENT_TOKEN` through your secret manager. Agent commands never use the saved developer key. Renew expired bearers through your pairing or token flow. The SDK also accepts an async `token` supplier for renewal.

```sh
boxox agent changes ADDRESS_ID --limit 100
boxox agent pending ADDRESS_ID --group support
boxox agent claim MESSAGE_ID --group support --lease-seconds 300
boxox agent message MESSAGE_ID --include-body true
boxox agent complete MESSAGE_ID --group support --claim-token -
```

The last command reads the claim token from standard input. Claim receipts contain that token. Exclude receipts from public logs.

## Capacity settings

The installer accepts these optional environment variables. Defaults preserve existing throttles and search behavior.

| Variable | Default | Purpose |
|---|---|---|
| `BOXOX_INBOUND_PER_MINUTE` | 300 | Inbound aggregate rate-limit guard |
| `BOXOX_SENDER_PER_MINUTE` | 60 | Per-sender rate-limit guard |
| `INGEST_MAX_CONCURRENCY` | 8 | Active ingestion slots; enrichment has its own equal bound |
| `AGENT_SEND_LIMIT_PER_15_MIN` | 200 | Shared human/agent send backstop; agent-specific caps still apply |
| `SEARCH_BODY_CHAR_LIMIT` | 32768 | Indexed characters per new message; 0 omits body indexing |
| `INDEX_ATTACHMENT_TEXT` | on | Set `off` to skip optional document-text extraction |

Changing indexing affects future processing and explicit reindexing. It does not delete originals or attachments. Raising application limits does not raise Cloudflare quotas or change its billing.

The signed-in owner can inspect `/api/operations/capacity` and `/api/operations/ingest?status=failed`. These endpoints report pending age, completed processing time, work states, and failed jobs. Logical stored bytes are not physical R2 or D1 usage. Use Cloudflare's dashboard for billing, database size, and queue backlog. Failed ingestion and enrichment jobs support explicit replay; raw mail stays stored.

Run `node scripts/benchmark-agent-scale.mjs` with Node.js 22.13+ to exercise 100,000 synthetic messages locally. The result checks coverage and bounded reads, not Cloudflare throughput or real-mailbox storage size.
