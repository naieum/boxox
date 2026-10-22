# Box Ox 2.4.6

Released October 21, 2026.

This release hardens the application after a second security review, adds the upgrade guide, and rewrites the website copy so it says what the product does and does not do. There is no database migration. The SDK, CLI and email skill packages are unchanged from 2.4.5 and keep their checksums.

## What was reviewed

A first-hand review read every request path in the Worker, the mail rendering pipeline, the developer API, the OAuth and MCP surface, and the web app's auth pages, then ran the test suite and a dependency audit. It found no critical or high issue. The core holds: Cloudflare Access sign-in is a verified token, every mutating request needs a same-origin header pair, mail HTML is sanitized twice and shown in a script-less frame with its own content security policy, remote images only load through the signing proxy after the reader allows them, API keys are hashed and scoped to one domain, and MCP consent requires PKCE and an exact redirect match.

The findings it did make are fixed below. Each has a regression test, and the review itself is published in the repository as `docs/security-review.md`.

## Security fixes

**Member-visible routes are now owner-only.** Anyone the Access policy admitted could list every domain, every address with every grantee's email and permissions, the unread count of every mailbox, and the sending quota, and could trigger DNS and Cloudflare API calls under the owner's credentials. Those routes now require the owner. Members still see their own mailboxes through the grant-filtered address list, which is what their UI uses.

**Shared labels can only be changed by the owner or their creator.** Any member could rename or recolor a label that everyone sees.

**Webhook signing secrets are encrypted at rest.** They were stored in plain text in D1, enough for anyone who could read the database to forge signed events to every customer endpoint. They are now envelope-encrypted. Secrets stored before this release still work, the five-minute recovery job re-encrypts them a batch at a time, and a delivery whose secret cannot be read is held back rather than sent unsigned.

**A second secret, `BOXOX_SIGNING_SECRET`.** Every non-JWT key, which means signed links and image-proxy URLs in mail, tracking tokens, raw-download URLs, the domain-connection cookie, Cloudflare OAuth token sealing and webhook secret sealing, now derives from its own installer-generated root. `AGENT_JWT_SECRET` signs agent credentials and nothing else, so a leak or rotation of either no longer reaches the other's purposes. The installer creates whichever secret is missing. The Deploy to Cloudflare form asks for both.

**The developer preview frame uses the message frame's policy.** The preview of API mail and templates lacked the per-frame content security policy that the inbox uses, so a remote image in a template variable could load. It now cannot.

**Smaller items.** The continuous-integration audit gate passes again after pinning a transitive `vite` dependency. The Google Fonts links, which the content security policy was already blocking, are gone, so the page no longer contacts Google on load.

## Upgrade guide

`docs/upgrade.md` documents what an upgrade is: the installer run again from newer source. It reuses every existing resource, applies pending database migrations, keeps dashboard variables, adds only the secrets that are missing, and checks that `/health` reports the deployed commit. The guide covers Deploy-button installations, after-upgrade checks, rollback with Wrangler, and the notes for moving from 2.4.5 and earlier to this release. State `BOXOX_PLAN` explicitly when upgrading: automatic plan detection needs a token with Billing Read, which Wrangler's sign-in does not grant.

## Node.js security releases

Node.js published security releases on October 21, 2026: 22.23.4, 24.22.1 and 26.12.1, with a Brotli decoder remote code execution and TLS hostname-check bypasses among the fixes. The deployed Box Ox runs on Cloudflare's runtime, not Node, and is not affected. Node runs the installer, the CLI and the SDK on your machine, so the requirements now ask for a current security release and warn off odd-numbered lines such as 25, which are unsupported.

## Website

The copy was rewritten after a marketing audit and a positioning pass. The home page now describes the product as the mail layer for an app you already run on Cloudflare Workers: a transactional email API, a threaded inbox where the replies land, and agent access you can revoke. The transactional-only scope of Cloudflare Email Service is stated wherever sending is promised. The R2 payment-method requirement is stated wherever the Free install is offered. `llms.txt` no longer says that no Free edition exists. The releases page describes the current version. The comparison pages link to a testing-status section instead of a page without one.

## Upgrading from 2.4.5 and earlier

Run `pnpm run deploy` from this source with the same account, owner email, URL and an explicit `BOXOX_PLAN`. The installer generates `BOXOX_SIGNING_SECRET`. Nothing else is needed. Tracking links in mail sent before this release were signed under the old derivation and no longer resolve; new mail is unaffected.

## Verification limits

The maintainer's own installation was upgraded from 2.4.0-era code to this source with the documented upgrade path, and `/health` reported the new commit. No fresh-account deployment, mail round trip, populated-mail recovery or throughput test was recorded for 2.4.6. The 2.4.0 fresh-account installation and removal evidence is retained in the release manifest. The release is unsigned; the same-site SHA-256 checksums check download consistency, not publisher identity.
