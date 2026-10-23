# Box Ox

[Website](https://boxox.dev/) · [Screenshots](https://boxox.dev/screenshots/) · [Setup guide](https://boxox.dev/setup/) · [API reference](https://boxox.dev/docs/api/)

| Profile | Deploy in your Cloudflare account |
| --- | --- |
| Free inbox: receiving, keyword search, and mail-reading agents | [![Deploy Free to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/naieum/boxox/tree/deploy-free) |
| Paid: adds sending, optional AI, semantic search, and browser features | [![Deploy Paid to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/naieum/boxox) |

If your account uses Workers Free, choose **Free inbox**. R2 activation and account quotas still apply.
Read the [Cloudflare button guide](docs/deploy-button.md) for build-token permissions and the Access/domain steps after deployment.

Box Ox is a mail client and transactional email API that you install in your own Cloudflare account.
One installation serves your domains, people, and agents. Cloudflare Email Service handles sending and receiving.
A Worker serves the React app, with D1 metadata, R2 mail storage, and Cloudflare Access sign-in.

The application includes threaded mail, compose and scheduled sends, labels, spam and phishing checks, search, and developer tools.
Optional AI supplies classification, priority and category views, summaries, and reply suggestions.
Agents connect through OAuth/MCP or the grant-limited agent API.

[Download Box Ox and read the setup guide](https://boxox.dev/downloads/).

[![A threaded conversation in the Box Ox V2 mail client](https://boxox.dev/screenshots/02-thread-1440.webp)](https://boxox.dev/screenshots/)

This repository contains the current Box Ox V2 application source and documentation.
The marketing website source and its build tools are maintained separately. Earlier private development history is not included.

**Release 2.4.8:** self-published source, CLI, SDK, and agent skill are available at [boxox.dev](https://boxox.dev/#install). MCP clients can request exact mailbox permissions before consent, and approval shows progress and recoverable errors; read the [release notes](docs/release-2.4.8.md).
**Tools update:** CLI 0.3.0 prepares exact MCP access requests, and email skill 0.5.0 covers mailbox connections, reading, and replies. Both target the existing 2.4.8 consent flow. Read the [tools release notes](docs/tools-0.3.0.md).

The CLI and SDK are direct downloads. There are no npm registry packages to install.

The 2.4.0 source installed in a fresh Workers Free account without domains, including owner sign-in and empty app pages.
The same empty installation later passed the agent removal procedure. Current installer changes have script coverage.
Mail delivery, populated-mail recovery, and Free throughput remain unverified in that fresh account.

Cloudflare Access and mail-domain setup remain installation steps. A successful `/health` response alone does not prove mail delivery.
Read the [release notes](docs/release-2.4.8.md) and verify the published checksums before installing.

## Browse the source

- `apps/web`: React mail client.
- `apps/worker`: Cloudflare Worker, mail processing, APIs, and agent access.
- `packages`: shared schemas, database models, SDK, and CLI.
- `migrations`: D1 schema migrations.

```sh
git clone https://github.com/naieum/boxox.git
cd boxox
pnpm install --frozen-lockfile
```

Follow the setup guide before deploying or connecting real domains.

## Agent automation

Request exact mailbox permissions before MCP login with scopes such as `boxox:read:hello@example.com`. The owner reviews those requested permissions before approving. See the [connection guide](docs/agent-automation.md#request-mcp-access-before-connecting).

Use a durable change checkpoint to discover mail, claim each message before
processing, and acknowledge completion. Bodies are opt-in and paginated. Reuse a
send idempotency key after timeouts. Shared processing groups can share that key.
See [agent automation](docs/agent-automation.md) and [2.4.0 changes](docs/release-2.4.0.md).

## Install

Requirements: Node.js 22 or later on a current security release (22.23.4, 24.22.1 or 26.12.1 and newer as of October 21, 2026; odd-numbered lines such as 25 are unsupported), pnpm 10.25.0, Git, Bash, a Cloudflare account with R2 activated, and Cloudflare Access.
Choose Workers Free for the inbox preview or Workers Paid for the full profile.
Mail needs a domain on Cloudflare DNS. The app can run before you connect one.

Require two-factor sign-in on both Cloudflare and GitHub. Use security keys where possible.

Follow the [setup guide](docs/setup.md) for the full procedure:

1. Clone this repository, or download and review a source release from [boxox.dev/downloads](https://boxox.dev/downloads/). If you use a ZIP, initialize and commit a local Git repository as described in the setup guide.
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

## Cloudflare services

Box Ox runs in your Cloudflare account. These services provide the application, storage, mail processing, and access controls.

| Service and official docs | Role |
| --- | --- |
| [Workers](https://developers.cloudflare.com/workers/) and [Static Assets](https://developers.cloudflare.com/workers/static-assets/) | Application server, React client, APIs, and MCP. |
| [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), and [KV](https://developers.cloudflare.com/kv/) | Mail metadata, private message storage, protocol state, and feeds. |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Queues](https://developers.cloudflare.com/queues/), and [Workflows](https://developers.cloudflare.com/workflows/) | Live mailbox updates, background processing, retries, and scheduled work. |
| [Email Service](https://developers.cloudflare.com/email-service/), [Email Routing](https://developers.cloudflare.com/email-routing/), and [DNS](https://developers.cloudflare.com/dns/) | Transactional sending, incoming mail, and domain records. |
| [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) and [Cloudflare OAuth](https://developers.cloudflare.com/fundamentals/oauth/) | Owner/member sign-in and authorization for domain management. |
| [Workers AI](https://developers.cloudflare.com/workers-ai/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/), and [Vectorize](https://developers.cloudflare.com/vectorize/) | Optional AI processing and semantic search when an embedding model is configured. |
| [Browser Run](https://developers.cloudflare.com/browser-run/) | Confirmed link previews and PDF export. |
| [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) and [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Inbound limits, retention, feed refresh, and recovery schedules. |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/), [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), and [Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) | Deployment, credentials, and operations. |

The [full Cloudflare service reference](docs/cloudflare-services.md) covers profile differences, optional security DNS lookups, and the declared Analytics Engine binding.
AI stays off until the owner enables it. The Free profile omits sending, AI, semantic search, and browser features.
The public website runs in a separate Worker and does not deploy with your mail application.

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
The [AI model reference](docs/cloudflare-services.md#ai-models-and-presets) lists each preset, its models, and where requests run.

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
Download the standalone CLI from [boxox.dev](https://boxox.dev/#developer-tools) and run it with Node.js 22 or later on a current security release.
You can also install the direct `.tgz` download with your package manager. The SDK and agent skill are available there too.

MCP uses `/mcp` with OAuth, PKCE, owner-approved clients, and revocation.
Agent actions remain subject to mailbox grants, sending caps, and the kill switch.
MCP cannot set up the owner or perform management-key operations.

## Maintenance and development

Prefer reviewed **signed release tags** when available, not `main`.
This self-published release has no signature. Its same-site SHA-256 checksums establish download consistency, not independent maintainer identity.
Verify each tag's signature against a trusted maintainer identity before merging it into a deployment branch.
A tag name alone is not verification. Do not treat an unsigned development branch as a signed release.

Review changes before Workers Builds deploys a connected branch.
Keep the lockfile and use frozen installs.

Before publishing, run `node scripts/install-gitleaks.mjs` once, then
`python3 scripts/check-release-privacy.py --tracked`. The site and tool-package
builds also scan generated archives. Missing scanners and unreadable archives
block publication. Keep credentials and installation-specific identifiers out of
examples. Allow reviewed test secrets only by exact path and source-line
hash in `scripts/release-secret-fixtures.json`.

Source ZIPs before 2.4.3 are withdrawn. Their manifests retain the original
checksums as historical records. Download the current release from
[boxox.dev/downloads](https://boxox.dev/downloads/).

The [setup guide](docs/setup.md) covers backups, paginated mbox export, retention, and local development.
Use the [threat model](docs/threat-model.md) to review security assumptions.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the source layout and local contribution checks.

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
