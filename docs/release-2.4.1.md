# Box Ox 2.4.1

Release date: October 19, 2026.

## Changes

- A copyable agent uninstall prompt and a removal guide for Free and Paid installations.
- A local resource inventory command that cannot apply changes or print configuration secrets.
- OAuth registration of a missing workers.dev account subdomain, with existing registrations preserved.
- An R2 activation check before resource creation and automatic creation of missing private mail buckets.
- Clear handoffs for Cloudflare checkout and permissions that deployment OAuth does not grant.

The removal procedure preserves mail by default. It requires resource review and approval before permanent deletion.
It covers mail migration, exports, revoked access, shared resources, and continuing charges.

## Verification

All 56 script tests passed. Site checks cover 41 pages and their internal links.
The uninstall prompt copied correctly in Chrome. The inventory ran against the fresh installation's generated config without account changes.

A separate Codex session installed the unchanged 2.4.0 source in a fresh Workers Free account without domains.
Deployment, Free bindings, protected owner access, and owner sign-in passed.
The empty Inbox and Domains pages loaded. Mail delivery and Free throughput remain unverified.
That test included user-completed Cloudflare checkouts and supervisor-configured Access policies.
The 2.4.1 installer changes have script coverage, but no separate fresh-account deployment certification.

At release time, no live uninstall or data deletion had run.
The later empty-install removal test appears in the [2.4.2 notes](https://boxox.dev/docs/releases/2.4.2/).
The removal guide does not claim an automatic DNS rollback.
Domain OAuth client registration still requires a credential with OAuth Client Write or separate setup.

SDK and CLI remain at 0.2.0. The email skill remains at 0.3.0.
This release is unsigned. Same-site SHA-256 checksums verify download consistency, not independent publisher identity.
