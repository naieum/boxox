# Box Ox

Box Ox is a mail client and transactional email API that you install in your own Cloudflare account.
One installation serves your domains, people, and agents. Cloudflare Email Service handles sending and receiving.
A Worker serves the React app, with D1 metadata, R2 mail storage, and Cloudflare Access sign-in.

The application includes threaded mail, compose and scheduled sends, labels, spam and phishing checks, search, and developer tools.
Optional AI supplies classification, priority and category views, summaries, and reply suggestions.
Agents connect through OAuth/MCP or the grant-limited agent API.

[Download Box Ox and read the setup guide](https://boxox.dev/#install).

**Release 2.4.8:** self-published source, CLI, SDK, and agent skill are available at [boxox.dev](https://boxox.dev/#install). MCP clients can request exact mailbox permissions before consent, and approval shows progress and recoverable errors; read the [release notes](docs/release-2.4.8.md).
The CLI and SDK are direct downloads; there are no npm registry packages to install.
The 2.4.0 source installed in a fresh Workers Free account without domains, including owner sign-in and empty app pages.
The same empty installation later passed the agent removal procedure. Current installer changes have script coverage.
Mail delivery, populated-mail recovery, and Free throughput remain unverified in that fresh account.
Cloudflare Access and mail-domain setup remain installation steps. A successful `/health` response alone does not prove mail delivery.
Read the [release notes](docs/release-2.4.5.md) and verify the published checksums before installing.

## Agent automation

Use a durable change checkpoint to discover mail, claim each message before
processing, and acknowledge completion. Bodies are opt-in and paginated. Reuse a
send idempotency key after timeouts; shared processing groups can share that key.
See [agent automation](docs/agent-automation.md) and [2.4.0 changes](docs/release-2.4.0.md).

## Install

Requirements: Node.js 22 or later on a current security release (22.23.4, 24.22.1 or 26.12.1 and newer as of October 21, 2026; odd-numbered lines such as 25 are unsupported), pnpm 10.25.0, Git, Bash, a Cloudflare account with R2 activated, and Cloudflare Access. Choose Workers Free for the inbox preview or Workers Paid for the full profile. Mail needs a domain on Cloudflare DNS; the app can run before one is connected.
Require two-factor sign-in on both Cloudflare and GitHub. Use security keys where possible.

Follow the [setup guide](docs/setup.md) for the full procedure:

1. Download and review the source. Initialize and commit a local Git repository as described in the setup guide.
2. Install dependencies with `pnpm install --frozen-lockfile` and authenticate with `pnpm exec wrangler login`.
3. Set `CF_ACCOUNT_ID` and `OWNER_EMAIL`. Leave `BOXOX_URL` unset for the free workers.dev app address, or set it to your custom HTTPS origin.
4. Run `pnpm run deploy` from a clean checkout.
5. Configure Cloudflare Access and its public-path exceptions.
6. Set the setup token, open `/setup`, and review every DNS and processing choice.
7. Test sending, receiving, delivery events, and grants on your installation.
8. Remove `CF_API_TOKEN` after setup.

Use `pnpm run deploy` explicitly. `pnpm deploy` invokes a different package-manager command.
Wrangler OAuth handles deployment. A separate setup token authorizes DNS and email onboarding.
The guide includes a [token template and permission checklist](docs/setup.md#create-the-setup-token).

To update an installation, follow the [upgrade guide](docs/upgrade.md): rerun the installer from the newer source with the same settings.
To remove an installation, follow the [uninstall guide](docs/uninstall.md).
It includes a copyable agent prompt, a local resource inventory, mail export, access revocation, and deletion checks.

## Sending restrictions and cost

Use the developer API for **transactional** mail from domains you own or have permission to use.
Box Ox does not provide broadcasts, audiences, or marketing campaigns.
Cloudflare's Email Service terms limit sending to messages tied to a specific customer interaction or transaction.
General-purpose conversational sending needs confirmation from Cloudflare before you rely on it.
See the [Email Service terms](https://www.cloudflare.com/service-specific-terms-developer-platform/#cloudflare-email-service) and [sending guide](https://developers.cloudflare.com/email-service/get-started/send-emails/).

As checked on October 18, 2026:

| Item | Starting cost |
| --- | --- |
| Workers Paid | $5 per month minimum |
| Email Sending | 3,000 emails per account per month included, then $0.35 per 1,000 |
| Email Routing | No per-message receiving charge. Worker execution and storage still count toward their product usage. |
| AI and other bindings | Usage-based charges and allowances apply. OpenAI/Anthropic through AI Gateway require prepaid credits. |

These figures are not a total-cost guarantee.
Check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) before enabling paid features.
New sending accounts may have Sandbox limits or recipient restrictions.
The Domains page shows the account quota. The setup guide includes `wrangler email` troubleshooting commands.

## What reads your mail

**AI reads email content when the owner enables the AI group.** AI stays off until the owner chooses it.
Setup separates local filters, reputation lookups, and AI into three explicit choices.
The owner can later change them under **Settings → Processing**, including address exceptions, rules, and the daily budget.

| Choice | Data flow |
| --- | --- |
| Local filters | Authentication checks, rules, Bayes learning, and campaign fingerprints run within your Cloudflare account. |
| Reputation lookups | Link domains go to Cloudflare's security DNS resolver. An optional Spamhaus key also enables IP/domain checks. OpenPhish is a downloaded feed. |
| OpenAI or Anthropic | Selected mail content leaves Cloudflare for the chosen provider through your account's AI Gateway. |
| Cloudflare only | The allow-listed open-weight model runs on Workers AI. Semantic search has no embedding model in this preset. |

Box Ox requests disabled gateway body logging/cache and a zero-data-retention routing preference.
**Gateway ZDR does not guarantee provider retention behavior.** Model support and provider terms still apply.
Cloudflare processing can occur outside the United States.

Review [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/), [OpenAI business terms](https://openai.com/policies/business-terms/), and [Anthropic commercial terms](https://www.anthropic.com/legal/commercial-terms).
The [model evaluation](docs/model-eval.md) records measured results and their limits.
The [processing guide](docs/processing-settings.md) explains budget and token-removal behavior.

R2 and D1 at-rest encryption relies on Cloudflare.
Box Ox adds no application-level mail encryption: the Worker needs readable content for search and mail processing.
Cloudflare and anyone with sufficient account access can access that data.

Link previews run only after an explicit request and confirmation.
Visiting a link can trigger one-click unsubscribe, confirmation, or magic-login actions.
PDF export blocks network requests while it renders stored mail.
AI reply suggestions enter an editable composer. Selecting one does not send mail.

## Developer and agent access

Use **Developer** for domain keys, templates, message logs, received mail, and signed webhook deliveries.
Read the [developer API and SDK guide](docs/api/README.md).
Download the standalone CLI from [boxox.dev](https://boxox.dev/#developer-tools) and run it with Node.js 22 or later on a current security release, or install the direct `.tgz` download with your package manager. The SDK and agent skill are available there too.

MCP uses `/mcp` with OAuth, PKCE, owner-approved clients, and revocation.
Request exact mailbox permissions before login with scopes such as `boxox:read:hello@example.com`; consent shows that request for approval. See the [MCP connection guide](docs/agent-automation.md#request-mcp-access-before-connecting).
Agent actions remain subject to mailbox grants, sending caps, and the kill switch.
MCP cannot perform owner setup or management-key operations.

## Maintenance and development

Prefer reviewed **signed release tags** when available, not `main`.
This self-published release is unsigned; its same-site SHA-256 checksums establish download consistency, not independent maintainer identity.
Verify each tag's signature against a trusted maintainer identity before merging it into a deployment branch.
A tag name alone is not verification. Do not treat an unsigned development branch as a signed release.
Review changes before Workers Builds deploys a connected branch.
Keep the lockfile and use frozen installs.

Before publishing, run `node scripts/install-gitleaks.mjs` once, then
`python3 scripts/check-release-privacy.py --tracked`. The site and tool-package
builds also scan generated archives. Missing scanners and unreadable archives
block publication. Keep credentials and installation-specific identifiers out of
examples. Reviewed test secrets are allowed only by exact path and source-line
hash in `scripts/release-secret-fixtures.json`.

Source ZIPs before 2.4.3 are withdrawn; their manifests retain the original
checksums as historical records. Download the current release from
[boxox.dev/downloads](https://boxox.dev/downloads/).

The [setup guide](docs/setup.md) covers backups, paginated mbox export, retention, and local development.
Use the [threat model](docs/threat-model.md) to review security assumptions.
Older V1 plans remain historical documents and do not describe the current storage or authentication system.

| Command | Purpose |
| --- | --- |
| `pnpm -r --if-present typecheck` | Check workspace types |
| `pnpm --filter @boxox/worker exec vitest run` | Run Worker tests with local D1/R2 and fake model bindings |
| `pnpm --filter @boxox/web build` | Build the web app |
| `pnpm run deploy` | Provision resources, migrate D1, build, and deploy |

## License

[Functional Source License 1.1, MIT Future License](LICENSE), SPDX `FSL-1.1-MIT`.
The license permits internal use. The license restricts competing commercial products and services.
Each version gains an MIT license two years after that version becomes available.
Read the license for its full terms.
