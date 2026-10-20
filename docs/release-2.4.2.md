# Box Ox 2.4.2

Release date: October 19, 2026.

## Changes

- Current release cards, documentation, structured data, and download tracking now use the same application version.
- Download tracking covers SDK and CLI 0.2.0 and each versioned application archive.
- Email skill 0.4.0 installs SDK and CLI 0.2.0 instead of the obsolete 0.1.0 downloads.
- Installation, Free-profile, and removal guides include the fresh-account test results.
- The removal runbook explains Access permissions and the dedicated-policy cleanup step.

SDK and CLI remain at 0.2.0. The API contract remains at 2.0.0 and brand assets at 1.1.0.
Previous release downloads keep their original bytes and checksums.

## Verified removal

The agent removal procedure removed the 2.4.0 test installation from a fresh Workers Free account.
That installation had no mail domain, messages, attachments, or R2 objects.

The test removed its Worker, two Durable Object namespaces, D1 database, KV namespace, R2 bucket, two queues, and three workflows.
It also removed two dedicated Access applications and their two unused policies.
Resource inventories were empty afterward. Seven old app endpoints returned 404.
The production website and mail service remained available.

CLI/API access handled the app resources. Access cleanup required the authorized Cloudflare dashboard because Wrangler OAuth lacked those permissions.
Both Wrangler profiles, account subscriptions, the shared Zero Trust organization, and the account's workers.dev registration remained.

## Limits

This was an empty, no-domain removal test. It did not test populated-mail exports, DNS migration, or replacement mail delivery.
The fresh-account installation test used unchanged 2.4.0 source, with user-completed billing checkouts and separate Access configuration.
There is no separate 2.4.2 fresh-account deployment or Free-throughput result.
The Free profile remains a preview. Installation does not include an automatic previous-provider DNS restore.

The release is unsigned. Same-site SHA-256 checksums check download consistency, not independent publisher identity.
