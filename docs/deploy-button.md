# Deploy to Cloudflare

Deploy Box Ox through Cloudflare Workers Builds. Choose the profile that matches your account before opening Cloudflare.

## Choose a profile

| Profile | Includes | Start deployment |
| --- | --- | --- |
| Free inbox | Receiving, attachments, labels, keyword search, webhooks, and mail-reading agents. No outbound sending, AI, or Browser Run. | [Deploy Free inbox](https://deploy.workers.cloudflare.com/?url=https://github.com/naieum/boxox/tree/deploy-free) |
| Paid | Adds transactional sending, optional AI, semantic search, and Browser Run. Requires Workers Paid. | [Deploy Paid profile](https://deploy.workers.cloudflare.com/?url=https://github.com/naieum/boxox) |

**For a Workers Free account, choose Free inbox.** You do not need a Workers Paid subscription for this profile.
Activate R2 before deploying. Account quotas and R2 overage charges apply.

Cloudflare reads the template bindings before running the installer.
The Free button uses the generated `deploy-free` branch, which omits paid-only bindings before Cloudflare checks the account.
Both templates contain the complete application workspace. The main branch remains the source for development.

The button copies this repository into your GitHub account and opens Cloudflare's deployment configuration.
It deploys the mail application. The separate `boxox.dev` website stays with this project.
Creating your passkey and connecting a mail domain follow the deployment.

**The button is the path with more to prepare.** Cloudflare's Workers Builds needs a deployment API token you create, because its default token cannot manage every resource Box Ox uses. The [local installer](https://boxox.dev/setup/) needs no token at all: it uses your Cloudflare sign-in on your own computer.

## Prepare your account

1. Choose the target Cloudflare account. Activate R2. For the Paid profile, confirm that Workers Paid is enabled.
2. Require two-factor sign-in on Cloudflare and GitHub. Use security keys where possible.
3. Create a deployment API token scoped to this account. Use it as the **Workers Builds API token**.
4. Grant the deployment permissions below. Keep this token out of Worker runtime secrets and committed files.
5. Use a new installation. Resource names default to `boxox`, `boxox-mail`, and the queue names in `wrangler.jsonc`.
   If that account already has Box Ox resources, review their names before deploying. The installer can reuse matching resources.

Cloudflare's default Builds token does not cover every resource the Box Ox installer manages.
Grant these account permissions to your custom deployment token:

| Account permission | Why the installer needs it |
| --- | --- |
| Account Settings: Read | Discover the account's workers.dev subdomain. |
| Workers Scripts: Edit | Upload the application, secrets, bindings, and migrations for Durable Objects. |
| D1: Edit | Find or create the mail database and apply schema migrations. |
| Workers R2 Storage: Edit | Check R2 activation and find or create the private mail bucket. |
| Workers KV Storage: Edit | Find or create protocol-state and feed storage. |
| Queues: Edit | Create the profile's queues and dead-letter queues. Free uses the webhook queue. |
| Vectorize: Edit, Paid only | Find or create the search index. |
| Workers AI: Read, Paid only | Bind the account's Workers AI service. |

Cloudflare can change permission labels. Compare them with the [API permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
For Wrangler account discovery, include the user permissions **User Details: Read** and **Memberships: Read**.
Worker deployment permissions also cover the Workflows and observability configuration.

The deployment token is the only credential this path needs. Box Ox registers no application with Cloudflare.

The button starts on workers.dev. If you later use a custom hostname, grant **Workers Routes: Edit** for its zone.
The Free template selects `free` without a billing API lookup. For the Paid template, set `BOXOX_PLAN=paid` in Builds.
The installer does not buy or change a subscription.

## Configure the deployment

Keep the repository root as the build directory. The Worker depends on sibling workspace packages and the web app.
Use the full repository URL in the button. A URL restricted to `apps/worker` would omit those dependencies.

Set these commands in Cloudflare:

| Setting | Value |
| --- | --- |
| Build command | `pnpm --filter @boxox/mail build` |
| Deploy command | `pnpm run deploy` |
| Node.js version | Leave unset; `.nvmrc` pins 22.23.4, a patched release |
| Build variable, Paid only | `BOXOX_PLAN=paid` |

Keep the pinned pnpm version from `package.json`. The deploy command checks types, builds the web app, provisions resources, and applies D1 migrations.
Do not replace it with a direct `wrangler deploy`. Use `pnpm run deploy` explicitly because `pnpm deploy` is a different command.

Fill the application fields shown by the deployment form:

| Field | Value |
| --- | --- |
| `CF_ACCOUNT_ID` | The account ID selected for this installation. |
| `OWNER_EMAIL` | The email address of the installation owner. |
| `BOXOX_EDITION`, Free template only | Keep `free`. Use the Paid button if you need the full profile. |

`CF_ACCOUNT_ID`, `OWNER_EMAIL`, and `BOXOX_EDITION` are non-secret Wrangler variables.
The form asks for no secrets. The installer generates the two signing secrets (`AGENT_JWT_SECRET`, `BOXOX_SIGNING_SECRET`) on the first deployment and keeps them on later ones; do not rotate them as a routine update.
If the form shows a field for `CF_API_TOKEN` or either signing secret, leave it empty.
If you override `CF_ACCOUNT_ID` or `OWNER_EMAIL` in Builds, those build values take precedence over the form's Wrangler values.
For token and variable configuration, see [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

Review the resource names and deploy. The installer uses D1 and KV identifiers already present in the generated Wrangler configuration.
If those identifiers are absent, it finds or creates resources by name.

For Paid, set the Vectorize index to **1536 dimensions** with the **cosine** metric.
Disable **Preview builds** for the initial installation. Review resource isolation before enabling previews for mail data.

## Finish the installation

1. **Create your passkey.** The end of the build log shows a single-use sign-in link for the owner. Open it and choose **Create passkey**. It expires in 24 hours, and anyone who can read the log can use it first, so open it promptly. See [owner sign-in](https://boxox.dev/docs/owner-access/).
2. **Connect your mail domain** from your own computer. Clone your copied repository, then:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run deploy
   pnpm run domain example.com
   ```

   `pnpm run deploy` signs in through Wrangler, redeploys the same source and records the installation's settings locally; `pnpm run domain` then uses that sign-in. If the first link expired, `pnpm run owner-link` makes a new one from the same checkout.
3. Open `/setup` and choose your mail-processing options.
4. Verify receiving and agent grants. For Paid, also verify sending and delivery events.
5. Protect your copied repository's deployment branch. Review changes before Builds deploys them.

Cloudflare Access is optional; the setup guide describes using it instead of passkeys.

The installer checks that `/health` reports the deployed source commit. That check does not prove owner sign-in or mail delivery.
The form-value and resource-reuse paths have offline script tests. We have not yet verified a fresh hosted button installation end to end.
The [local installer](https://boxox.dev/setup/) remains available if the hosted flow fails.

Read Cloudflare's [Deploy to Cloudflare documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) for the platform's provisioning behavior and limits.
See [Cloudflare services](https://boxox.dev/docs/cloudflare-services/) for every service used by Box Ox.

## Page not found after login

Cloudflare can retain a different account in the login redirect.
If the account in that URL is unavailable, select **Back to accounts** and choose your installation account.
Then reopen the matching deployment button above.

If the Free button asks for Workers Paid, check that the repository URL ends in `/tree/deploy-free`.
The Paid button declares Browser Run and other full-profile services, so Cloudflare requires Workers Paid before installation.
