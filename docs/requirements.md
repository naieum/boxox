# Requirements and Cloudflare costs

Box Ox installs a Free inbox profile or a full Paid profile. Cloudflare bills your account directly. Box Ox has no subscription or per-inbox fee.

## Free and Paid

Workers Paid starts at $5 USD per month per account. Your Workers share the account allowances. This minimum is not a total-cost estimate.

Cloudflare includes 3,000 outbound Email Service messages per month. Additional messages cost $0.35 per 1,000. Account quotas and sandbox restrictions can limit sending.

Email Routing is available on Free and Paid without a per-message routing charge. Worker processing and storage have separate limits and charges.

Free permits sending to verified destination addresses in your account. Sending to arbitrary recipients requires Paid. Queues, Workflows, and Vectorize also have Free capabilities. Their presence alone does not require Paid.

The Free inbox profile supports receiving, keyword search, mail-reading agents, and inbound webhooks. It omits outbound sending, AI, semantic search, and Browser Run.
Read the [Free profile guide](https://boxox.dev/docs/free/) for setup and preview verification limits.

| Allowance | Workers Free | Workers Paid |
| --- | --- | --- |
| Worker requests | 100,000 per day | 10 million per month included |
| Worker CPU | 10 ms per invocation | 30 million CPU ms per month included |
| Queue operations | 10,000 per day | 1 million per month included |
| Queue retention | 24 hours | Longer retention available |

Figures checked October 18, 2026. Review [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), and [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).

## Account

You need permission to create the declared resources in your Cloudflare account. Enable R2 through Cloudflare's checkout before deployment. It requires a payment method and acceptance of terms even on Workers Free. The installer creates the configured mail bucket after activation. Enable Workers Paid only if you want the full profile. Workers Paid is separate from your website zone plan. You do not need a Pro website plan.

Configure a Cloudflare Access team and an Access application for owner and member sign-in. Set the owner identity and protect the app hostname. Follow the [setup guide](https://boxox.dev/setup/) for public protocol paths. Protected APIs fail closed until you configure Access.

## Domains

The app can use your account’s free `workers.dev` address or an optional custom hostname such as `mail.example.com`. A website address does not provide an email domain.

Mail requires a domain you control in the same Cloudflare account’s DNS zones. Configure and verify SPF, DKIM, and DMARC for sending.

**Before enabling receiving, review existing MX records.** Receiving can replace your current mail provider. For sending only, keep the existing MX records.

To receive mail, enable Email Routing and route messages to your Worker. Catch-all receiving requires a zone apex.

Email Service supports transactional messages. Review [Cloudflare’s Email Service terms](https://www.cloudflare.com/service-specific-terms-developer-platform/#cloudflare-email-service) for your use case.

## Deployment tools

Install these tools on your computer or CI runner:

- Node.js 22 or later on a current security release (22.23.4, 24.22.1 or 26.12.1 and newer as of October 21, 2026; odd-numbered lines such as 25 are unsupported). Node runs the installer, the CLI and the SDK on your machine; the deployed app runs on Cloudflare's runtime, not Node.
- pnpm 10.25.0.
- Git.
- Bash for the root deployment helper. On Windows, use a configured Bash environment such as WSL.

Use the source ZIP and its frozen lockfile. Run `pnpm install --frozen-lockfile` to install the bundled Wrangler. Authorize Wrangler for the installation account, or use a suitably scoped CI credential.

The standalone CLI requires Node.js 22 or later on a current security release, your installation URL, and a Box Ox credential for the task.

The app and remote MCP run on your Worker. The CLI runs on your computer or CI. Cloudflare administration permissions are separate from Box Ox mail permissions.

## Provisioned resources

The deployment helper selects the profile before provisioning. Automatic selection needs Billing Read.
If Wrangler OAuth cannot read the plan, check the dashboard and set `BOXOX_PLAN=free` or `BOXOX_PLAN=paid`.
It creates or reuses these shared resources:

- A Worker and D1 database.
- A KV namespace and the declared R2 mail bucket.
- Queues and dead-letter queues.

Wrangler deploys the declared Workflows, SQLite Durable Object, rate limits, and other bindings. The Paid profile also declares Vectorize, Workers AI, Browser Run, outbound sending, and an Analytics Engine dataset.
The Free profile uses a SQLite Durable Object for heavier processing. It retains ingestion, optional keyword enrichment, and snooze workflows and the inbound-webhook queue.

AI starts off. Browser quick actions run on demand and can add usage charges. The analytics binding does not provide an aggregate mail analytics dashboard.

Mail volume, attachments, retention, background work, and optional features affect costs. R2 has separate billing. Its free allowances can cover a small inbox, but overages can incur charges on Workers Free.
Review pricing for [R2](https://developers.cloudflare.com/r2/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Workflows](https://developers.cloudflare.com/workflows/reference/pricing/), and [Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/).

## Credentials and agents

Domain onboarding can use **Connect with Cloudflare** after the installation has its own OAuth client.
Creating that client requires OAuth Client Write or separate owner setup.
If the client is unavailable, use the temporary API-token fallback. Scope the token to the chosen account, zones, and setup operations.
Remove the token after onboarding. Normal mail transport continues through service bindings.

Keep deployment credentials separate from mail API keys and agent grants. After deployment, approve the agent’s OAuth/mailbox grants or create a credential for its task. Copying the installation link grants no access.

Normal mail requires no external AI provider key while AI is off. If you enable AI, selected email content goes to the chosen service. Provider credentials and usage charges then apply. Read the [processing guide](https://boxox.dev/docs/processing/) before enabling it.

## Installation checks

Before relying on the installation, verify:

1. Sign in as the owner.
2. Check restricted mailbox access.
3. On Paid, send an external message and confirm its delivery event.
4. On Free, send a message from an outside mailbox you control to the installed inbox.
5. Confirm incoming mail appears in the right thread.
6. Check the grants used by your application or agent.

A successful deployment or health response does not verify mail delivery.
The unchanged 2.4.0 source installed in a fresh Workers Free account without domains.
Owner sign-in and empty app pages passed after billing checkouts and separate Access configuration.
The agent removal procedure later removed the empty installation and its dedicated resources.
Mail delivery, populated-mail recovery, and Free throughput remain unverified.

There is no separate fresh-account deployment result for the current patch release. The Free profile remains a preview.

## License and support

The application uses FSL-1.1-MIT. It permits internal use and restricts competing commercial services. The SDK and CLI use MIT. Read the [license](https://boxox.dev/license/) for the full terms.

The download includes no managed hosting or support response-time guarantee. Cloudflare handles its service charges. Contact [Box Ox](https://boxox.dev/contact/) for setup questions, bugs, or licensing.
