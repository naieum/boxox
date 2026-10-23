# Install Box Ox for your user

Box Ox is a mail client and transactional email API installed into the user's own Cloudflare account. This page is a technical runbook, not permission to spend money, publish private source, replace mail DNS, or change unrelated applications. Apply the user's instructions and your tool's confirmation rules.

## Entry points

- Project download: https://boxox.dev/downloads/boxox-v2.zip
- Source version, ZIP size and SHA-256: https://boxox.dev/downloads/release.json
- Checksum file: https://boxox.dev/downloads/SHA256SUMS.txt
- Full setup guide: https://boxox.dev/setup/
- License: https://boxox.dev/license.txt (FSL-1.1-MIT)

Box Ox 2.4.8 is a self-published, unsigned release. Verify its SHA-256 against the metadata before extracting.
Same-site checksums check download consistency, not independent publisher identity. Review the source before running it.
Source ZIPs before 2.4.5 have been withdrawn. Use the current manifest and download; archived manifests describe historical bytes that may no longer be available.

Fresh-account checks used unchanged 2.4.0 source on Workers Free without domains.
Deployment, owner sign-in, and empty app pages passed after Cloudflare checkouts and separate Access configuration.
The agent removal procedure later removed that empty installation. CLI/API calls handled app resources, and the authorized dashboard handled Access.

Current installer changes have script coverage, without a separate fresh-account deployment result for this patch release.
Mail delivery, populated-mail recovery, and Free throughput remain unverified.

Use this runbook. No one-click installation is claimed. Box Ox is free. The installer picks the inbox install on Cloudflare Workers Free or the full install on Workers Paid. Dedicated Workers Free CPU/quota verification is still pending.

## 1. Establish the installation account

Use Node.js 22 or later on a current security release (22.23.4, 24.22.1 or 26.12.1 and newer as of October 21, 2026) and pnpm 10.25.0. Check `node -v` first; an older patch release or an odd-numbered line such as 25 should be updated before running the installer. Use installed Cloudflare CLI, MCP, and deployment skills where available. The project ships a pinned Wrangler dependency and a deployment helper. You do not need a Cloudflare MCP connection to run it.

Prefer CLI and API operations. The installer does not require control of the user's personal browser. Ask the user to complete Cloudflare sign-in, service checkout, and any required consent on the specific official page. If deployment OAuth lacks Access administration or OAuth Client Write, use an authorized credential with those permissions or hand off that configuration; do not assume browser automation is required.

Use an existing authorized Cloudflare login or run `pnpm exec wrangler login`. Confirm the account with `pnpm exec wrangler whoami`. The installer detects the Workers subscription through the account subscriptions API. This needs Billing Read. Wrangler OAuth does not include that permission.

A separate read-only `BOXOX_BILLING_TOKEN` can come from the user’s secret manager. It is not stored in the Worker. If detection is denied, check the Workers plan in the dashboard and set `BOXOX_PLAN=free` or `BOXOX_PLAN=paid`. Never infer Workers Paid from a website’s Pro/Business plan, an authorization error, or `default_usage_model`. Disclose infrastructure charges. Do not purchase or change a plan without the user’s authorization.

On Workers Free it installs the inbox: inbound mail, attachments, keyword search, scoped mail-reading agents, and inbound webhooks. It omits outbound sending, AI, Vectorize, Browser Run, and the delivery-event subscription. Paid installs the full profile. Both need R2, which requires a payment method on file. A mail domain is needed to send or receive mail, not to install. R2 overages can cost money. Review https://boxox.dev/docs/free/.

Determine the owner email from the user's chosen sign-in identity. Do not assume the Cloudflare account administrator must also be the Box Ox owner. Never print credentials or put tokens in command arguments, Git, URLs, or chat. Use an existing secrets manager or Wrangler's interactive secret prompts.

## 2. Choose the app address separately from the email domain

The app can run at `https://boxox.<account-subdomain>.workers.dev`. No purchased website domain is required. Leave `BOXOX_URL` unset to use that address. The helper preserves an existing account subdomain. When none exists, it registers `boxox-<first 12 account-ID characters>` through the authorized Cloudflare API and verifies the result. Set `BOXOX_WORKERS_SUBDOMAIN` before deployment to choose another name. A registration failure stops deployment; do not rename an existing account subdomain to work around it. The helper sets the app's `PUBLIC_URL` and disables preview URLs.

If the user wants a custom app hostname, set `BOXOX_URL` to its HTTPS origin, such as `https://mail.example.com`. This configures a Worker Custom Domain and disables workers.dev and preview URLs. Keep that variable on later deployments.

Sending and receiving email still require a domain the user controls on Cloudflare DNS. The workers.dev address hosts the app. It is not an email domain. The app can be deployed before a mail domain is connected, but mail setup and round-trip testing cannot be completed without one. Do not claim operational email until those steps pass.

## 3. Extract, review and deploy

Use a new local directory. The ZIP has no Git history. Initialize and commit a local repository so deployment can identify the installed source:

```sh
cd boxox-v2
git init
git add .
git commit -m "Import reviewed Box Ox source"
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

Use an authenticated existing login instead of repeating login when appropriate. Set `CF_ACCOUNT_ID` to the selected account and `OWNER_EMAIL` to the chosen owner. Leave `BOXOX_URL` unset for workers.dev, or set it to the reviewed custom app hostname. Then run:

```sh
pnpm run deploy
```

Use `pnpm run deploy`, including `run`. `pnpm deploy` is a different command.

Before running, inspect the account for name collisions. Defaults assume one installation per account and reuse resources named `boxox`, `boxox-KV`, `boxox-mail`, `boxox-search`, `cf-email-events`, `cf-email-events-dlq`, `webhook-delivery`, and `webhook-delivery-dlq`, plus the declared workflows. Never overwrite or repurpose another installation to complete a test. Renaming only the Worker does not isolate all resources. For multiple installations, rename all declared resources and rate-limit namespace IDs, then commit the config. The deployment helper carries the configured Worker, queue, and bucket names into runtime onboarding.

Enable R2 in the selected account before deployment. Cloudflare requires its R2 checkout, including a payment method and acceptance of terms, even on Workers Free. R2 has free allowances and bills overages. Apply the user's spending authorization and tool confirmation rules. Deployment OAuth can create buckets after activation; it cannot replace checkout. The helper checks R2 availability before creating resources, creates missing configured mail buckets privately, and preserves existing bucket contents and settings. Review bucket names in `wrangler.jsonc` during the collision checks above.

The helper provisions the other declared resources, builds the app, and applies D1 migrations. It generates an initial signing secret when needed and deploys the Worker. It writes installation resource IDs to ignored `.wrangler/deploy/wrangler.json`. Do not commit that file or replace an existing signing secret during an update.

## 4. Protect owner access

Follow the full setup guide's Cloudflare Access section. Configure a self-hosted Access application on the actual app hostname, including workers.dev when that is the chosen address. Allow only the owner and explicitly approved members. Do not alter policies shared by unrelated projects.

Set `ACCESS_AUD` and `TEAM_DOMAIN` as Worker secrets using the generated installation config. Protected APIs fail closed until those values are configured.

Create the exact public protocol path exceptions listed in the setup guide for MCP/OAuth, developer and agent API credentials, signed file/tracking links, and health. Keep the owner app, setup, consent and owner APIs protected. Never bypass all of `/api/*` or `/oauth/*`.

## 5. Connect the mail domain

Follow the setup guide to obtain a temporary, scoped setup token and store it as `CF_API_TOKEN`. The deployment OAuth token does not replace that setup token. Deployment OAuth can lack DNS and Access administration scopes. Do not keep retrying a permission failure or weaken Access to work around it.

Open `/setup` as the owner. On Paid, review sending-only versus receiving. Free is receiving-only. Receiving can replace existing MX records and move mail away from the user's current provider. Present the concrete DNS changes and obtain any confirmation required by the user or tools before replacing a provider. Sending-only must preserve existing MX records.

Add later domains through **Domains → Add domain → Connect with Cloudflare**. The owner approves access in Cloudflare; Box Ox encrypts the authorization in D1 and renews access automatically. The installer creates an installation-owned private OAuth client when authorized with OAuth Client Write. If that permission is missing, use authorized Cloudflare tools to register the client once, then deploy with its public `CF_OAUTH_CLIENT_ID`. Follow https://boxox.dev/docs/cloudflare-connection/ for exact settings and profile-specific scopes. Never copy Wrangler’s login or refresh token into the Worker. Receiving requires Zone Settings Write (`zone-settings.write`) as well as Email Routing Rules Write. For an existing OAuth client, update its registration and have the owner reconnect to approve the new permission. API tokens need Zone Settings Edit on the selected zones. The advanced API-token fallback remains available. Review the DNS preview and receiving confirmation. Do not reset completed setup or modify D1 flags. If no mail domain is available, report app deployment and authentication separately and leave domain-dependent checks incomplete.

Ask the user to choose local filters and reputation lookups separately. On Paid, also ask about AI. The Workers Free inbox install leaves AI unavailable. Do not enable AI on real mail by assumption.

External AI providers receive selected content when enabled. Keep AI off unless the user opts in. Remove the setup token after onboarding. Ordinary mail uses bindings.

## 6. Verify outcomes

Verify each result independently and report what ran:

1. `/health` returns the installed source commit. Health alone does not prove mail delivery.
2. An anonymous owner request requires Access. Missing API/agent credentials are rejected.
3. The owner signs in and can create/access the intended addresses.
4. On Paid, a transactional test message reaches a controlled mailbox and has a delivered event. Its standalone copy appears in Sent, outside Inbox. On Free, an outside message arrives in the installed inbox.
5. On Paid, a received reply brings the correct Box Ox conversation into Inbox. Verify plus addressing on either profile when enabled.
6. If the user needs the developer API, a domain-scoped key cannot access another domain. Test a signed webhook only against an authorized receiver.
7. Disabled AI makes no model calls.

Sending test messages is an external action: use only destinations authorized by the user and apply your tool's confirmation rules. Do not send to arbitrary addresses.

If an account restriction, billing requirement, DNS permission or login needs the user, identify the precise step and continue independent work. Do not label untested steps passed. Distinguish a fresh set of resources in an existing account from a truly fresh Cloudflare account. Leave the user the app URL, installation commit, resource names, verification results, and any remaining configuration.

## Developer tools and agent skill

These files are hosted directly by Box Ox, with no npm registry publication:

- Standalone CLI: https://boxox.dev/downloads/boxox-cli-0.2.0.mjs (run with Node.js 22 or later on a current security release).
- Installable CLI package: https://boxox.dev/downloads/boxox-cli-0.2.0.tgz.
- SDK package: https://boxox.dev/downloads/boxox-mail-0.2.0.tgz.
- Application integration skill: https://boxox.dev/downloads/boxox-email-skill-0.4.1.zip.

Verify all downloads against SHA256SUMS.txt. Install the local SDK tarball with the project's package manager, for example `npm install ./boxox-mail-0.2.0.tgz`.
Install the CLI tarball locally or globally, or invoke the standalone file with `node boxox-cli-0.2.0.mjs --help`.
Extract the skill ZIP into the agent's skill directory as `boxox-email`. It contains SKILL.md, helpers, and a local integration check.
The remote mail MCP endpoint remains on the user's Worker at `/mcp`. These downloads do not move mail storage or MCP onto the user's computer.

Before starting MCP authorization, identify the exact mailbox addresses and permissions needed for the task. Request each permission as an OAuth scope: `boxox:read:hello@example.com` for reading, or `boxox:send:hello@example.com` for replies. Do not request `send_new`, `webhook`, or `classify` unless the task needs them. With an MCP server configured as `boxox`, Codex accepts `codex mcp login boxox --scopes 'boxox:read:hello@example.com,boxox:read:ian@example.com'`. The owner reviews those requested mailboxes and permissions on the consent screen. See https://boxox.dev/docs/agent-automation/ for the complete flow. After connecting, verify the grants with `list_addresses`; do not assume a combined owner inbox means access to every mailbox.

## Application email and template work

Use the current [Box Ox email skill](https://boxox.dev/downloads/boxox-email-skill-0.4.1.zip), verified against [resource checksums](https://boxox.dev/downloads/RESOURCE-SHA256SUMS.txt). Template authors must read its bundled email-design review before publishing. The [human-readable guide](https://boxox.dev/docs/email-design/) contains the same review.

## Removing an installation

Use https://boxox.dev/docs/uninstall/ for the removal guide and copyable agent prompt.
Agents follow https://boxox.dev/uninstall-agent.md . Keep mail by default and review exact resource IDs before deletion.
Move incoming mail before removing its Worker. Preserve shared resources and account subscriptions.
