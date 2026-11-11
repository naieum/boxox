# Install with your agent

## Copy the install link

Give your coding agent this URL:

```text
https://boxox.dev/install-agent.md
```

The runbook covers account checks, deployment, owner sign-in, DNS, and a mail round trip.
Copying the link grants no access to your account.

## Choose the account and domain

Tell your agent:

- Which Cloudflare account to use. The installer checks Workers Free or Paid. The full profile needs Paid, from $5/month plus usage, billed by Cloudflare.
- Which email domain to connect. Its DNS zone must belong to that account.
- Which email address should own the installation.
- Whether to keep your existing receiving provider or move receiving to Box Ox.

A custom website hostname is optional. The app can use your free `workers.dev` address.
Sending and receiving still require a mail domain you control.

**Receiving can replace your existing MX records.** Review the DNS preview before approving that change.
For sending only, keep your current MX records.

## Authorize setup

The installer cannot read your Workers plan on a first install, because Cloudflare's sign-in for tools has no billing permission.
Tell your agent whether the account is on Workers Free or Workers Paid; it sets `BOXOX_PLAN=free` or `BOXOX_PLAN=paid`.
The installer never purchases or changes a plan.
Read the [Workers Free guide](https://boxox.dev/docs/free/) for the inbox install’s features and testing status.

If the computer is not signed in to Cloudflare, the installer opens Cloudflare's page asking you to allow Wrangler,
Cloudflare's own deployment tool. You approve that yourself. It is the only credential step: there are no API tokens
for you or your agent to create, and nothing to paste into a chat.

When the installer finishes it prints a single-use link. **Open that link yourself** to create your passkey;
it makes whoever opens it the owner, so your agent should hand it to you and not open it.
Your agent then connects your mail domain with `pnpm run domain example.com`, after showing you what will change.

See [owner sign-in](https://boxox.dev/docs/owner-access/) for how sign-in works and how to add other people.

## Review the result

Ask your agent to report:

1. The installation URL and deployed source version.
2. A successful owner sign-in and a denied unauthorized request.
3. On Paid, receipt of an outbound test message and its delivery event. On Free, receipt at the installed inbox.
4. An inbound reply in the correct thread, if receiving is enabled.
5. The mail permissions granted to your applications and agents.

A healthy Worker alone does not verify mail delivery.
Follow the [installation checks](https://boxox.dev/docs/verification/) before relying on the service.

## Connect agents to mail

The remote MCP endpoint runs on your Worker. The CLI runs on your computer or CI.
Approve the agent’s OAuth and mailbox grants, or create a mail key scoped to its task.
These permissions do not grant Cloudflare account administration.

Use [llms.txt](https://boxox.dev/llms.txt) as the discovery entry point. The [agent runbook](https://boxox.dev/install-agent.md) includes CLI and skill installation and the MCP connection flow, with a direct path for existing installations.

Install CLI 0.3.0 and the [email skill 0.5.0](https://boxox.dev/downloads/boxox-email-skill-0.5.0.zip), verified against the [tool checksums](https://boxox.dev/downloads/RESOURCE-SHA256SUMS.txt). Prepare the exact mailbox permissions with `boxox mcp request` before OAuth. MCP runs on your existing Worker; the agent configures its client endpoint and verifies mailbox grants after approval. SDK 0.2.0 is only needed for application integration.
Template agents must follow the [email design review](https://boxox.dev/docs/email-design/).
