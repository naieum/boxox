# Box Ox

[Website](https://boxox.dev/) · [Screenshots](https://boxox.dev/screenshots/) · [Setup guide](docs/setup.md) · [API reference](docs/api/README.md)

Box Ox is a mail client and transactional email API that you install in your own Cloudflare account.
One installation serves your domains, people, and agents. Cloudflare Email Service handles sending and receiving.
A Worker serves the React app, with D1 metadata, R2 mail storage, and Cloudflare Access sign-in.

It includes threaded mail, compose and scheduled sends, labels, spam and phishing checks, search, and developer tools.
Optional AI adds classification, priority and category views, summaries, and reply suggestions.
Agents connect through OAuth/MCP or the grant-limited agent API.

[![A threaded conversation in the Box Ox mail client](https://boxox.dev/screenshots/02-thread-1440.webp)](https://boxox.dev/screenshots/)

**Current release: 2.4.9** — a security release that requires a patched Node.js and clears high-severity zod, undici, and body-parser advisories. See the [release notes](docs/release-2.4.9.md). CLI 0.3.0 and email skill 0.5.0 are described in the [tools release notes](docs/tools-0.3.0.md).

## Deploy with the Cloudflare button

| Profile | Deploy in your Cloudflare account |
| --- | --- |
| Free inbox: receiving, keyword search, and mail-reading agents | [![Deploy Free to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/naieum/boxox/tree/deploy-free) |
| Paid: adds sending, optional AI, semantic search, and browser features | [![Deploy Paid to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/naieum/boxox) |

If your account uses Workers Free, choose **Free inbox**. R2 must be activated, and account quotas apply.
After deployment, follow the [Cloudflare button guide](docs/deploy-button.md) for the build-token permissions, Access, and domain steps.
Leave the Node.js version setting in Workers Builds unset. The build reads `.nvmrc`.

## Install from source

Requirements:

- Node.js 22.23.4, 24.22.1, or 26.12.1 or newer on those lines. Odd-numbered lines such as 25 are unsupported. `pnpm install` stops on an unpatched version.
- pnpm 10.25.0, Git, and Bash (use WSL on Windows).
- A Cloudflare account with R2 activated and Cloudflare Access. Workers Free runs the inbox profile; Workers Paid runs the full profile.
- A domain on Cloudflare DNS for mail. The app can run on workers.dev before you connect one.
- Two-factor sign-in on Cloudflare and GitHub, with security keys where possible.

Follow the [setup guide](docs/setup.md) for the full procedure:

1. Clone this repository, or download and review a source release from [boxox.dev/downloads](https://boxox.dev/downloads/) and verify its checksum. If you use a ZIP, initialize and commit a local Git repository as the setup guide describes.
2. Run `pnpm install --frozen-lockfile` and `pnpm exec wrangler login`.
3. Set `CF_ACCOUNT_ID` and `OWNER_EMAIL`. Leave `BOXOX_URL` unset for the workers.dev address, or set it to your custom HTTPS origin.
4. Run `pnpm run deploy` from a clean checkout. (`pnpm deploy` is a different pnpm command.)
5. Configure Cloudflare Access and its public-path exceptions.
6. Set the setup token, open `/setup`, and review every DNS and processing choice. See the [token template and permission checklist](docs/setup.md#create-the-setup-token).
7. Test sending, receiving, delivery events, and grants. A successful `/health` response does not prove mail delivery.
8. Remove `CF_API_TOKEN` after setup.

**Receiving moves the domain's mail to Box Ox.** Enabling Email Routing can replace existing MX records. The setup wizard shows them and asks before replacing another mail provider.

To update, follow the [upgrade guide](docs/upgrade.md): rerun the installer from the newer source with the same settings.
To remove an installation, follow the [uninstall guide](docs/uninstall.md).

Releases are unsigned. Published SHA-256 checksums confirm the download is unchanged, not who published it. Review changes before deploying them.

## Sending restrictions and cost

Use the developer API for **transactional** mail from domains you own or have permission to use.
Box Ox has no broadcasts, audiences, or marketing campaigns.
Cloudflare's [Email Service terms](https://www.cloudflare.com/service-specific-terms-developer-platform/#cloudflare-email-service) limit sending to messages tied to a specific customer interaction or transaction. Get confirmation from Cloudflare before relying on it for general conversational sending.

As checked on October 18, 2026:

| Item | Starting cost |
| --- | --- |
| Workers Paid | $5 per month minimum |
| Email Sending | 3,000 emails per account per month included, then $0.35 per 1,000 |
| Email Routing | No per-message receiving charge. Worker execution and storage still count. |
| AI and other bindings | Usage-based. OpenAI/Anthropic through AI Gateway require prepaid credits. |

Check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) before enabling paid features.
New sending accounts may have Sandbox limits or recipient restrictions.

## What reads your mail

**AI stays off until the owner enables it.** Setup offers three separate choices, which you can change later under **Settings → Processing**:

| Choice | Data flow |
| --- | --- |
| Local filters | Authentication checks, rules, Bayes learning, and campaign fingerprints run in your Cloudflare account. |
| Reputation lookups | Link domains go to Cloudflare's security DNS resolver. An optional Spamhaus key adds IP/domain checks. OpenPhish is a downloaded feed. |
| AI: OpenAI or Anthropic | Selected mail content goes to the chosen provider through your account's AI Gateway. |
| AI: Cloudflare only | An allow-listed open-weight model runs on Workers AI. |

Box Ox requests disabled gateway logging and caching and a zero-data-retention routing preference. This does not guarantee provider retention behavior. Cloudflare processing can occur outside the United States.
Mail is stored readable in R2 and D1, encrypted at rest by Cloudflare. Anyone with sufficient account access can read it.
Link previews run only after you confirm them. AI reply suggestions open in the composer and are never sent automatically.

See the [processing guide](docs/processing-settings.md), the [AI model reference](docs/cloudflare-services.md#ai-models-and-presets), and the [threat model](docs/threat-model.md).

## Developer and agent access

- **Developer API:** domain keys, templates, message logs, received mail, and signed webhooks. Read the [API and SDK guide](docs/api/README.md).
- **CLI, SDK, and email skill:** direct downloads from [boxox.dev](https://boxox.dev/#developer-tools), not npm packages.
- **MCP:** `/mcp` with OAuth, PKCE, owner-approved clients, and revocation. Request exact mailbox permissions before login with scopes such as `boxox:read:hello@example.com`, or let `boxox mcp request` build them. Agents stay subject to mailbox grants, sending caps, and the kill switch.

See [agent automation](docs/agent-automation.md) for connecting agents and processing mail reliably.

## Cloudflare services

Box Ox uses Workers, Static Assets, D1, R2, KV, Durable Objects, Queues, Workflows, Email Service, Email Routing, DNS, Access, Rate Limiting, and Cron Triggers.
The Paid profile can also use Workers AI, AI Gateway, Vectorize, and Browser Run.
The [Cloudflare services reference](docs/cloudflare-services.md) explains each binding and the differences between profiles.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the source layout and checks.

## License

[Functional Source License 1.1, MIT Future License](LICENSE) (`FSL-1.1-MIT`).
Internal use is permitted; competing commercial products and services are restricted.
Each version becomes MIT-licensed two years after release. Read the license for full terms.
