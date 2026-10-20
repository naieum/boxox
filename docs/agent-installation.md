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

Automatic plan detection needs Billing Read. Wrangler OAuth does not include it.
Your agent can use a separate read-only `BOXOX_BILLING_TOKEN` from your secret manager.
If unavailable, check the Workers plan in Cloudflare and choose `BOXOX_PLAN=free` or `BOXOX_PLAN=paid`.
The installer never purchases or changes a plan.
Read the [Free profile guide](https://boxox.dev/docs/free/) for its features and preview limits.

Authorize your agent through the Cloudflare tools you use.
Deployment credentials and the temporary domain-setup token are separate from Box Ox mail keys.
Do not paste secrets into a public chat or commit them to source.

Your agent must configure Cloudflare Access for owner sign-in.
After initial onboarding, remove the temporary Worker setup token. Normal mail continues through service bindings.
For later domains, use **Domains → Add domain → Connect with Cloudflare**. Approve access once; Box Ox renews it automatically. Your agent must register the installation’s private OAuth client if its deployment credential lacks OAuth Client Write. See [Cloudflare connection setup](/docs/cloudflare-connection/).

See [owner access and token scopes](https://boxox.dev/docs/owner-access/) for the exact permissions.

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

For application email, download the [email skill](https://boxox.dev/downloads/boxox-email-skill-0.4.0.zip).
Template agents must follow the [email design review](https://boxox.dev/docs/email-design/).
