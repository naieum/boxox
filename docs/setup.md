# Install and maintain Box Ox V2

This guide describes the current root deployment scripts.
A deployed Worker and a successful `/health` check do not prove that mail sending, receiving, or delivery events work.
Complete the installation checks below for your account.

## Before you start

Review the [Workers Free and Paid requirements](https://boxox.dev/requirements/) before deploying.
Box Ox uses one download. The installer selects a Free inbox profile or the full Paid profile.
Read the [Free profile guide](https://boxox.dev/docs/free/) for included features and preview limits.

Use Node.js 22 or later, pnpm 10.25.0, Git, a Bash shell, and a Cloudflare account with R2 enabled. Workers Paid is needed for the full profile.
The root deployment helper is a Bash script. On Windows, use a configured Bash environment such as WSL.
The web app can run at `boxox.<your-account-subdomain>.workers.dev`; a custom website domain is optional.
The installer can register a free account subdomain through Cloudflare's API when none exists.
Sending and receiving mail still require a domain you control. The account must own the DNS zones you onboard.
Use Cloudflare Access for owner and member sign-in.
Require two-factor sign-in on Cloudflare and GitHub. Prefer security keys.

Email Service sending is for **transactional** messages from domains you own or have permission to use.
Review the [service terms](https://www.cloudflare.com/service-specific-terms-developer-platform/#cloudflare-email-service).
Get confirmation from Cloudflare before relying on it for general-purpose conversational sending.
Box Ox has no broadcasts, audiences, or marketing campaigns.

**Receiving moves the domain's mail to Box Ox.** Enabling Email Routing can replace existing MX records.
Choose sending only if you intend to keep receiving mail at Google Workspace, Microsoft 365, or another provider.

The wizard shows existing MX records and requires confirmation before replacing a foreign mail provider.
Back up the existing DNS configuration before making that choice.
Subdomains can send. Catch-all receiving requires a zone apex.

## Review and deploy the source

For hosted deployment, choose Free or Paid in the [Deploy to Cloudflare guide](https://boxox.dev/docs/deploy-button/).
The procedure below uses the local installer and supports both profiles.
The [Cloudflare services reference](https://boxox.dev/docs/cloudflare-services/) explains the bindings and links to their official documentation.

Download the published source snapshot from [boxox.dev](https://boxox.dev/downloads/#developer-tools).
Verify its SHA-256 against the published checksum, unzip it, and review the source.
The checksum detects a changed download; it is not a signed release or independent trust proof.
The snapshot includes no Git history. Initialize a local repository so deployment can identify your source:

```sh
cd boxox-v2
git init
git add .
git commit -m "Import reviewed Box Ox source"
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

If you already have access to the upstream repository, use your reviewed fork instead.
Use reviewed signed release tags when available, rather than updating directly from `main`.
Verify the tag signature against a trusted maintainer identity, then review the changes before deploying.
For example, replace `REVIEWED_TAG` with the tag you reviewed:

```sh
git fetch origin --tags
git tag -v REVIEWED_TAG
git switch --detach REVIEWED_TAG
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

These commands do not establish that a signed release exists.
A valid signature from an unknown identity is not sufficient verification.

Automatic plan detection needs Billing Read. A separate `BOXOX_BILLING_TOKEN` can supply a read-only token from your secret manager.
Wrangler OAuth cannot read billing. If needed, check **Workers & Pages** and set `BOXOX_PLAN=free` or `BOXOX_PLAN=paid`.
The installer stops before provisioning if it cannot verify the plan and you have not selected one.

Set the installation account and owner identity in the deployment shell:

```sh
export CF_ACCOUNT_ID='your-cloudflare-account-id'
export OWNER_EMAIL='you@example.com'
# Optional: omit BOXOX_URL to use your free workers.dev app address.
# export BOXOX_URL='https://mail.example.com'
pnpm run deploy
```

Use an HTTPS origin for `BOXOX_URL`, with no path.
It configures a Worker custom domain and disables the workers.dev and preview URLs.
Without it, the helper discovers your registered account subdomain, enables workers.dev, and sets
`PUBLIC_URL` to `https://boxox.<your-account-subdomain>.workers.dev`. Configure Access for that hostname.
Preview URLs stay disabled in both cases. The Worker rejects owner API requests until Access is configured.
If the account has no workers.dev subdomain, the helper registers `boxox-<first 12 account-ID characters>` and verifies it. Set `BOXOX_WORKERS_SUBDOMAIN` to choose another name before the first deployment. Existing account subdomains stay unchanged.
Set `CF_ACCOUNT_ID` and `OWNER_EMAIL` on every deployment.
The owner email must match the identity Cloudflare Access verifies.

Use **`pnpm run deploy`**, including `run`. `pnpm deploy` is a different pnpm command.
The script requires a clean Git checkout so its public health response identifies the deployed commit.
It builds the SDK and web app, checks workspace types, provisions resources, applies remote D1 migrations, and deploys Worker `boxox`.
For both address options, the script checks that `/health` reports the deployed source commit.
Keep the same `BOXOX_URL` on subsequent deployments if you use a custom domain.

The helper checks R2 activation before creating resources. On a fresh account, complete [Cloudflare's R2 checkout](https://developers.cloudflare.com/r2/get-started/) first. It requires a payment method and acceptance of terms even on Workers Free. R2 includes free allowances; Cloudflare bills overages. The installer does not activate subscriptions.

The helper finds or creates these account resources:

| Resource | Default name |
| --- | --- |
| D1 database | `boxox` |
| KV namespace | `boxox-KV` |
| R2 bucket | `boxox-mail` |
| Vectorize index | `boxox-search`, 1,536 dimensions, cosine distance |
| Event queues | `cf-email-events`, `cf-email-events-dlq` |
| Webhook queues | `webhook-delivery`, `webhook-delivery-dlq` |

Wrangler also deploys the Workflows, Durable Object, and declared bindings.
The helper writes account resource IDs to ignored `.wrangler/deploy/wrangler.json`.
It creates two secrets on the first deployment and removes the temporary secret file after deployment:
`AGENT_JWT_SECRET`, which signs agent credentials and nothing else, and `BOXOX_SIGNING_SECRET`, which derives
every other key (signed links and images in mail, tracking tokens, raw-download URLs, the domain-connection
cookie, Cloudflare OAuth token sealing, webhook secret sealing). Existing secrets remain in place; a later
deployment adds only whichever one is missing. Do not rotate either as a routine update: rotating
`AGENT_JWT_SECRET` signs every agent out, and rotating `BOXOX_SIGNING_SECRET` breaks links in already-sent
mail and makes sealed OAuth tokens and webhook secrets unreadable.

The helper reuses resource names in the same account.
Review existing resources before installing. The defaults assume one Box Ox installation per account.
Wrangler OAuth is the default deployment credential.
CI can supply `CLOUDFLARE_API_TOKEN` with permission to manage the resources in `wrangler.jsonc`.
This deployment credential is separate from the temporary setup token below.

## Configure Cloudflare Access

1. Create a self-hosted Access application for the app hostname.
2. Allow the owner email set in `OWNER_EMAIL`.
3. Add members to the Access policy as needed. Mail access also requires address grants inside Box Ox.
4. Create path-specific Access bypass rules for the public protocol endpoints below.
5. Record the application's audience tag and your team's HTTPS domain.

| Bypass paths | Authentication handled by Box Ox |
| --- | --- |
| `/mcp`, `/mcp/*` | MCP OAuth |
| `/oauth/token`, `/oauth/register`, `/.well-known/*` | OAuth protocol checks |
| `/api/agent`, `/api/agent/*` | Agent credentials |
| `/dev/v1`, `/dev/v1/*` | Developer API keys |
| `/t/*`, `/f/*` | Tracking or file URL signatures |
| `/health`, `/health/*` | Public operational status, without mail content |

Configure both exact paths and descendant paths where listed.
Keep `/oauth/authorize`, consent pages, `/setup`, the app, and owner APIs behind Access.
Do not bypass all of `/oauth/*` or `/api/*`.
Check that a more general Access application does not override the intended path policy.

Set the values interactively, using the generated installation config:

```sh
pnpm exec wrangler secret put ACCESS_AUD --config .wrangler/deploy/wrangler.json
pnpm exec wrangler secret put TEAM_DOMAIN --config .wrangler/deploy/wrangler.json
```

`TEAM_DOMAIN` is the HTTPS origin, such as `https://your-team.cloudflareaccess.com`.
Do not put a trailing path in it.
The Worker verifies the Access JWT and its audience. It fails closed on protected routes until both settings exist.
A public health response does not verify Access configuration.

## Create the setup token

Create a short-lived Cloudflare API token restricted to the installation account and the zones you plan to onboard.
The [starter token template](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22queues%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=Box%20Ox%20setup) provides a starting point.
It preselects Zone Read, DNS Edit, Queues Edit, and Workers R2 Edit.
**The template is incomplete:** add the Email Sending, Email Routing, and AI Gateway permissions required by your choices.
Replace its broad account and zone selections before creating the token.
Cloudflare can change permission labels. Use the setup screen's checks to find missing scopes.

| Permission | Use |
| --- | --- |
| Zone Read | List and inspect your zones |
| DNS Edit | Apply the reviewed sending and receiving DNS records |
| Email Sending Edit, Paid only | Enable sending and inspect account limits |
| Email Routing Edit | Enable receiving, catch-all rules, and subaddressing |
| Queues Edit, Paid domain setup only | Subscribe email delivery events to the event queue |
| Workers R2 Edit | Inspect lifecycle rules during setup; manage lifecycle rules through the Cloudflare API |
| AI Gateway Edit, when AI is enabled | Apply gateway privacy and spending settings and check billing access |

Store the token as a Worker secret. Paste it at the prompt:

```sh
pnpm exec wrangler secret put CF_API_TOKEN --config .wrangler/deploy/wrangler.json
```

The deployment helper already sets `CF_ACCOUNT_ID`.
Do not commit tokens to source or paste them into command arguments.
The wizard can verify token status and probe its account access before changing DNS.

## Complete the owner wizard

Open `/setup` through Access as the owner.

1. Check the token results. On Paid, also review the sending quota or Sandbox restrictions.
2. Select a zone and inspect the DNS preview. Free is receiving-only. Paid also offers sending-only setup without MX changes.
3. If you enable receiving, confirm any replacement of existing MX records and the resulting change of mail provider.
4. Review SPF, DKIM, and DMARC results. The wizard retains an existing DMARC record and shows a warning.
5. Choose local filters, reputation lookups, and AI separately. Each choice requires an explicit answer.
6. If AI is enabled, choose a provider and fund third-party AI Gateway credits as required.
7. On Paid, send the wizard's test message and inspect its receipt. On Free, follow the incoming-mail test instructions.
8. Finish setup, then create your addresses and member grants in the app.

Receiving configuration targets Worker `boxox`, enables subaddressing, and, on Paid, subscribes delivery events to `cf-email-events`.
The setup screen probes R2 lifecycle access. Review the installed bucket rules separately.
The wizard does not currently apply mail-expiry rules.
A returned sending message ID records acceptance. It does not establish delivery.

Setup locks its onboarding mutations after completion.
The **Domains** page adds later domains with the same DNS preview and explicit receiving confirmation, and manages domains and addresses.
Choose **Domains → Add domain → Connect with Cloudflare** to connect another domain.
Approve access once. Box Ox encrypts the authorization and renews access automatically.
The installer registers a private OAuth client when its credential has OAuth Client Write. An installation agent can register it once if that permission is missing.
See [Cloudflare connection setup](/docs/cloudflare-connection/) for the client settings and the advanced token fallback.
**Disconnect** removes the saved authorization and attempts to revoke it in Cloudflare.
Use **Settings → Processing** for later processing changes.
See the [processing guide](processing-settings.md) for API fields and budget behavior.

**AI reads email content when enabled.** OpenAI or Anthropic receives selected content through your account's AI Gateway.
The Cloudflare-only preset runs on Workers AI. It has no embedding model, so search remains keyword-only.
Cloudflare processing is not restricted to the United States by this application.

Gateway body logging and caching are disabled, with a zero-data-retention routing preference.
That preference does not guarantee provider retention behavior. Check the chosen provider and model terms.

R2 and D1 at-rest encryption relies on Cloudflare.
Box Ox does not add application-level mail encryption because the Worker needs readable content for search and processing.
Sufficient Cloudflare account access can expose stored mail.
Require two-factor sign-in and limit account membership.

Remove the setup token when onboarding is complete:

```sh
pnpm exec wrangler secret delete CF_API_TOKEN --config .wrangler/deploy/wrangler.json
```

Normal sending and receiving use bindings and continue without it.
Add a replacement token temporarily when onboarding another domain or enabling AI/changing an enabled provider.
Turning AI off, address opt-outs, and local rule changes do not require the token.

With the token removed, a budget change updates the app limit but leaves the old gateway backstop in place.
Concurrent requests can pass the app budget check together. The app counter is not a strict billing ceiling.
Restore the token and save the budget again to synchronize the gateway limit, then remove it.
A daily app budget of zero refuses new AI calls.

## Check your installation

Use only mailboxes, domains, and webhook receivers you control for these checks.

- Open the app without a session and confirm Access sign-in. Confirm Access also protects `/oauth/authorize`.
- Sign in as the owner and confirm that a member without a grant cannot read the owner's addresses.
- Send a transactional message to an external mailbox you control. Check receipt and a delivered event in the message log.
- Reply from that mailbox and confirm the reply arrives in the correct thread.
- Send to a plus-tagged address and confirm the intended address receives it.
- Create a domain API key and verify that it cannot operate on a different domain.
- If using webhooks, verify a signed event at your controlled HTTPS receiver.
- Confirm that disabled AI does not make model calls. Request a summary only after enabling AI deliberately.

A preview request visits the selected link only after confirmation.
That visit can trigger one-click unsubscribe, confirmation, or magic-login actions.
PDF export renders stored mail with network access blocked.
Keep preview checks separate from a mail-delivery check.

Run and review these checks before relying on the installation.

## Diagnose Email Service setup

Use the locked Wrangler version installed by `pnpm install --frozen-lockfile`.
These commands inspect account and domain state:

```sh
pnpm exec wrangler --version
pnpm exec wrangler whoami
pnpm exec wrangler email sending list
pnpm exec wrangler email sending settings example.com
pnpm exec wrangler email sending dns get example.com
pnpm exec wrangler email routing list
pnpm exec wrangler email routing settings example.com
pnpm exec wrangler email routing dns get example.com
```

Replace `example.com` with your zone.
If `wrangler email` is missing, check that you used the repository's frozen lockfile rather than a global Wrangler installation.
For authorization errors, check the selected account, token expiry, account role, and setup-token scopes.
Use `pnpm exec wrangler login` to refresh deployment OAuth when needed.
Do not print or share the OAuth token to diagnose a failed API request.

If sending is not verified, compare the sending DNS report with the zone's SPF, DKIM, and DMARC records.
Do not delete unrelated records or add a second SPF record to fix a conflict.
Review the wizard's DNS changes first.
If Email Service accepts a message but it never arrives, inspect its delivery events. Check Sandbox restrictions, recipient limits, suppression, and the recipient's spam folder.

If receiving fails, inspect MX records, Email Routing status, the catch-all Worker target, and Workflow errors.
For missing delivery events, inspect the `cf-email-events` queue and domain event subscription.
Check the dead-letter queues for exhausted retries.
A healthy Worker HTTP endpoint alone does not check those paths.

## Backups, export, and retention

D1 Time Travel provides account-level database recovery. Confirm the current retention window in your Cloudflare plan.
Back up R2 objects separately and keep database metadata and objects from a consistent period.
A D1 restore does not restore deleted R2 objects.
The app's FTS5 tables prevent ordinary `wrangler d1 export` from providing a complete SQL backup. Do not rely on it without testing a restore.

The authenticated owner/member export API returns mail from addresses the caller can read:

| Endpoint | Result |
| --- | --- |
| `/api/orgs/default/export/status` | Counts of accessible mail and retained originals |
| `/api/orgs/default/export/manifest.ndjson` | Metadata, original-byte hashes where available, and fidelity indicators |
| `/api/orgs/default/export/mbox` | Mail in mbox format |

Exports contain at most 200 messages per request.
Read `X-Next-Cursor` and request the next page with the `cursor` query parameter until `X-Complete` is `true`.
Concatenate the pages in order and retain the manifest with the mbox file.
A single response is not necessarily a complete backup.
There is no archive-assembly job or V1 mailbox import in this release.

The exporter uses original RFC message bytes where retained.
If the original is missing, it reconstructs a message from stored fields, with attachment descriptors rather than a byte-exact original.
Inspect fidelity and hash fields instead of assuming every exported message is an original.

The retention sweep permanently removes threads that have stayed in Trash for 30 days. It also removes their mail objects and search data.
Operational events expire after 90 days and audit events after 365 days.

The root onboarding helper preserves existing R2 rules and adds seven-day cleanup for incomplete multipart uploads when missing.
It does not expire all stored mail. The D1-aware Trash sweep handles application deletion.

Existing R2 lifecycle rules can still remove configured object prefixes independently of D1.
Inspect the installed lifecycle rules before setting your backup schedule.

## Updates and local development

For removal, use the [uninstall guide](https://boxox.dev/docs/uninstall/) and its copyable agent prompt.
Keep mail by default. Review resource ownership and move incoming mail before removing its Worker.

Use reviewed release tags instead of `main`. The current release is unsigned.
When a signed tag is available, verify its signature against a trusted maintainer identity.
Inspect migrations and dependency changes before deploying. Back up the installation and run the workspace checks.
Keep `OWNER_EMAIL` and the installation account set when running `pnpm run deploy` again.
If Workers Builds watches a branch, review what will merge into that branch before it deploys.
The CLI deployment path applies D1 migrations. Do not assume another build command does so.

For local development, copy the example secrets file at the repository root:

```sh
cp .dev.vars.example .dev.vars
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm --filter @boxox/mail build
pnpm --filter @boxox/web build
pnpm --filter @boxox/worker dev
```

Run `pnpm --filter @boxox/web dev` in a second terminal.
Fill `.dev.vars` with development credentials as needed. Add `CF_ACCOUNT_ID` and `OWNER_EMAIL` for your local installation. Never commit it.

Local protected routes still require valid Access configuration and identity.
A plain unauthenticated local request can return 503 until you configure Access. Do not disable authentication to make it pass.

Run local checks with `pnpm -r --if-present typecheck`, `pnpm --filter @boxox/worker exec vitest run`, and `pnpm --filter @boxox/web build`.
Worker tests use local D1/R2 and fake model bindings.
Remote bindings, including Browser Run, can access paid account services when you invoke them.

## Release installation verification

Box Ox is distributed directly from boxox.dev as a source ZIP, standalone CLI, SDK package, and agent skill.
Use the CLI deployment procedure above or give your agent https://boxox.dev/install-agent.md.
There is no npm registry publication and no one-click deployment claim.

The source-download installation was exercised with isolated Worker, D1, R2, KV, Vectorize, Queue, and Workflow resources in an existing Workers Paid account.
That test covered provisioning, migrations, workers.dev hosting, source-version health, and rejection of anonymous protected/API requests.
It does not establish behavior on a brand-new Cloudflare account or complete your domain/Access setup for you.
Use the mail checks above on each installation before relying on it.
The unchanged 2.4.0 source also installed in a fresh Workers Free account without domains.
Owner sign-in and empty app pages passed after user-completed billing checkouts and separate Access configuration.
The agent removal procedure later removed that empty installation and its dedicated resources.
Mail delivery, populated-mail recovery, and Free throughput remain unverified.
There is no separate fresh-account deployment result for the current patch release.

For an additional installation in the same account, give **all** resources unique names in `wrangler.jsonc`: Worker, D1, R2, Vectorize, queues and dead-letter queues, workflows, analytics dataset, and rate-limit namespace IDs.
KV is named from the Worker name. Commit those changes before deployment.
The helper carries the configured Worker, email-events queue, webhook queue, and mail bucket names into runtime onboarding.
