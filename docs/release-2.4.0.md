# Box Ox 2.4.0

Agents can resume mailbox work after interruptions, share processing queues,
and request message content without downloading entire conversations.

## Agent APIs

- Thread and message pagination replaces the agent API's first-100 limit.
- A durable change feed returns replay checkpoints and removal events.
- Claims have renewable leases, delayed retries, and idempotent acknowledgment.
- Shared groups coordinate agents; processing state is separate from read/unread.
- Reply idempotency works across REST and MCP, including shared groups.
- Bounded acknowledgment batches accept up to ten claims.

**Compatibility:** `get_thread` now returns metadata by default. Request
`includeBody: true` for text and follow `nextCursor`. Body pages contain at most
ten messages, with 32,768 characters per body and explicit truncation indicators.
Use SDK and CLI 0.2.0 for these APIs. Older download URLs remain available.

## Ingestion and operations

The ingestion ledger records work before raw mail is saved. Durable dispatch,
bounded concurrency, reconciliation, and owner replay recover interrupted jobs.
Required screening finishes before agent access. Optional attachment extraction
and semantic indexing run separately from delivery notifications.

The owner can inspect pending lag, processing latency, failed jobs, and unresolved
send outcomes under `/api/operations`. Deployment settings control throughput and
indexed text without deleting original messages or attachments.

## Verification limits

The offline capacity gate exercises production query code and real migrations
with 100,000 synthetic messages, including a 1,000-message conversation. This
checks data coverage and bounded reads; it does not certify Cloudflare throughput.
Storage depends on message and attachment sizes. New-account installation and
actual Workers Free account limits remain unverified.

Read the [agent automation guide](https://boxox.dev/docs/agent-automation/).
