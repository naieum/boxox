# Free inbox profile

The same Box Ox download can install a Free inbox profile or the full Paid profile.
The installer checks the account’s Workers subscription before creating resources.
It never buys or changes a Cloudflare plan.

[Deploy Free inbox to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/naieum/boxox/tree/deploy-free).
This template omits paid-only bindings before Cloudflare checks your account.
Read the [hosted deployment guide](https://boxox.dev/docs/deploy-button/) for resource and Access setup.

## Included features

| Feature | Free inbox | Paid |
| --- | --- | --- |
| Inbox, attachments, labels, and keyword search | Included | Included |
| Scoped mail-reading agents and MCP | Included | Included |
| Inbound webhooks | Included | Included |
| Outbound sending and sent-mail copies | Not installed | Included |
| AI, semantic search, and Browser Run | Not installed | Available with consent/configuration |

Cloudflare allows verified-destination sends on Free, but this Box Ox profile does not install outbound sending.

## Plan detection

Automatic detection uses Cloudflare’s account subscription API and needs **Billing Read**.
A separate `BOXOX_BILLING_TOKEN` can supply that read-only permission while Wrangler handles deployment.
Keep the token in your secret manager or environment. It is not stored in the Worker.

Wrangler OAuth cannot read billing subscriptions.
If detection is unavailable, check **Workers & Pages** in Cloudflare, then choose the matching profile:

```sh
BOXOX_PLAN=free pnpm run deploy
```

Use `BOXOX_PLAN=paid` only after confirming Workers Paid is enabled.
A website’s Pro or Business plan does not establish the Workers plan.

## Costs and limits

Workers Free has no $5 monthly minimum. Account-wide quotas still apply.
R2 must be enabled separately. Storage and operations beyond its free allowances can incur Cloudflare charges.

A mail domain is required to send or receive mail. You can install and explore the app without one.
The app can use a free `workers.dev` address.

The Free profile moves heavier processing into a SQLite Durable Object and keeps Workflow retries.
Large mailboxes and high mail volume can exhaust free quotas.

## Upgrade

After upgrading Workers in Cloudflare, rerun the same installer.
Keep the same account, resource names, owner email, and app URL.
The Paid profile reuses the mail database and bucket, then adds the other bindings.
Enable sending for your domain in **Domains**. AI still needs your separate consent.

If you installed from the generated `deploy-free` branch, first review its retained `wrangler.paid.jsonc` configuration.
Copy the Worker name, owner/account variables, and resource names and identifiers from `wrangler.jsonc`.
Match the D1, KV, R2, and webhook queue bindings in the Paid configuration.
If you use a custom hostname, keep the same `BOXOX_URL`. Commit the reviewed configuration, then run:

```sh
BOXOX_CONFIG=wrangler.paid.jsonc BOXOX_PLAN=paid pnpm run deploy
```

Changing `BOXOX_EDITION` alone does not add the Paid bindings. The installer refuses that incomplete upgrade.

The installer refuses to replace an existing full installation with the Free profile.
Downgrading a live mail service needs a separate migration review.

## Preview status

The Free profile passes local tests with paid-only bindings removed.
The unchanged 2.4.0 source also installed in a fresh Workers Free account without domains.
Owner sign-in and empty Inbox and Domains pages passed after billing checkouts and separate Access configuration.
The agent removal procedure later removed that empty installation and its dedicated resources.
Mail delivery, populated-mail recovery, and enforced CPU and volume limits remain unverified.
There is no separate fresh-account deployment result for the current patch release.
