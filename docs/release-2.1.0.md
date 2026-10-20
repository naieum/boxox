# Box Ox 2.1.0

## One installer, two profiles

The installer checks the Cloudflare Workers subscription before provisioning.
Free accounts get an inbox profile. Paid accounts get the full installation.
A failed plan check stops before resource changes.
Wrangler OAuth users can select a profile after checking their account, or provide a separate Billing Read token for automatic detection.

## Free inbox preview

- Inbox, attachments, labels, and keyword search.
- Scoped mail-reading agents and MCP.
- Signed inbound webhooks.
- Workflow retries, with heavier work in a SQLite Durable Object.
- No outbound sending, AI, semantic index, Browser Run, or email delivery-event subscription.

Skipped features stay unavailable in the UI and server APIs.
Upgrading Workers and rerunning the installer preserves the database and mail bucket.
The installer refuses an automatic downgrade of an existing full installation.

## Verification

The profile has dedicated tests with paid-only bindings absent.
These cover streamed inbound mail, the complete ingest workflow, search indexing, MCP reading, blocked sending, and receiving-only domain setup.

Live validation uses isolated resources in an existing Paid account.
This does not certify Workers Free CPU limits or account quotas.
Review the [Free profile guide](https://boxox.dev/docs/free/) before using it.

## Downloads

Use the source download and checksums on the [downloads page](https://boxox.dev/downloads/).
The SDK, CLI, and email skill keep their existing versions.
This source release is unsigned. Same-site checksums check download consistency, not independent publisher identity.
