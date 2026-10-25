# Upgrade Box Ox

An upgrade is the installer run again from newer source against the same installation. There is no separate upgrade command: `pnpm run deploy` reuses every resource that already exists, applies pending database migrations, uploads the new Worker, adds only the secrets that are missing, and checks that `/health` reports the deployed commit.

This page covers installations made with the local installer and with the Deploy to Cloudflare button. To remove an installation instead, use the [uninstall guide](https://boxox.dev/docs/uninstall/).

## Before you upgrade

1. Find the version you run. `/health` on your mail hostname reports the source commit:

   ```sh
   curl https://mail.example.com/health
   ```

2. Read the release notes for every version between yours and the target (`docs/release-*.md`). Note any migration, new setting or new secret they mention.
3. Check out the target. Use a reviewed release tag rather than `main`. The installer refuses to run from a checkout with uncommitted changes, so `/health` always names real source.
4. Install dependencies and run the checks:

   ```sh
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm --filter @boxox/worker exec vitest run
   ```

5. Take a backup. Export mail as described under [Backups, export, and retention](https://boxox.dev/docs/backups/), and record the current Worker version so you can roll back:

   ```sh
   pnpm exec wrangler deployments list --name boxox
   ```

6. Confirm Wrangler is signed in to the installation account with `pnpm exec wrangler whoami`.

## Run the upgrade

Use the same values as the first deployment. `BOXOX_URL` is your mail hostname. `BOXOX_PLAN` is the profile you installed, `free` or `paid`; state it explicitly, because automatic detection needs a token with Billing Read, which Wrangler's OAuth sign-in does not grant.

```sh
CF_ACCOUNT_ID=<account id> OWNER_EMAIL=<owner email> BOXOX_URL=https://mail.example.com BOXOX_PLAN=paid pnpm run deploy
```

On an existing installation the installer:

- reuses the D1 database, R2 buckets, KV namespace, queues and Vectorize index by name, and creates nothing that already exists;
- refuses to replace a full installation with the Free profile;
- applies pending D1 migrations to the remote database before uploading code;
- uploads the Worker with `--keep-vars`, so variables set in the dashboard survive, and sets `BUILD_SHA` to the deployed commit;
- adds secrets that are missing and never rotates ones that exist;
- waits up to a minute for `/health` to report the deployed commit, and fails if it does not.

Cloudflare Access, DNS, Email Routing, the sending subdomain, event subscriptions and stored mail are not touched.

### Installations made with the Deploy to Cloudflare button

Workers Builds runs the same installer whenever the connected branch changes. To upgrade, merge the target release into your copied repository's deployment branch after reviewing it, and keep `BOXOX_PLAN=paid` as a build variable for a Paid installation. Builds adds any missing secret the same way the local installer does. Review the build log and `/health` afterwards.

## After the upgrade

- `/health` reports the target commit.
- Sign in through Cloudflare Access and open the inbox.
- Send a test message from the Domains page and confirm it arrives. On Paid, also confirm a delivery event reaches the message.
- If the release notes mention new processing choices, review **Settings → Processing**.
- `pnpm exec wrangler secret list --name boxox` lists `ACCESS_AUD`, `TEAM_DOMAIN`, `AGENT_JWT_SECRET` and `BOXOX_SIGNING_SECRET`.

## Roll back

Code rolls back; the database does not.

- **Worker:** `pnpm exec wrangler rollback --name boxox` restores a previous version. Pick the version id you recorded before upgrading. Check `wrangler secret list` afterwards, and never delete `AGENT_JWT_SECRET` or `BOXOX_SIGNING_SECRET` while rolling back: the first signs every agent out, the second makes sealed tokens, webhook secrets and links in sent mail unreadable.
- **Database:** D1 migrations are forward only. Box Ox migrations add tables, columns and indexes rather than removing them, so older code usually runs against a newer schema, but read the migration you are stepping back over before relying on that. If the data itself must go back, restore from your export.
- **Mail:** stored mail in R2 is never changed by an upgrade or a rollback.

## Version notes

### From 2.4.8 to 2.4.9

- Use Node.js 22.23.4, 24.22.1, 26.12.1, or a newer release on those lines. `pnpm install` now stops with `ERR_PNPM_UNSUPPORTED_ENGINE` on an unpatched Node.js.
- Deploy to Cloudflare installations: the repository's `.nvmrc` sets the Workers Builds Node.js version. Remove any `NODE_VERSION` build variable that pins an older release.
- The Worker moves to zod 4. Request limits and defaults are unchanged; some validation error messages are worded differently.
- No database migration, new secret, or reconnection is required.

### From 2.4.7 to 2.4.8

- MCP clients can request exact mailbox permissions before authorization with scopes such as `boxox:read:hello@example.com`. Consent lists that request for approval. Clients without mailbox scopes retain a collapsed manual setup option.
- Approval shows progress and recoverable errors. Repeating an approval with matching grants retains its agent connection.
- Existing connections keep their approved grants. No database migration, new secret, or reconnection is required for them.

### From 2.4.6 and earlier to 2.4.7

- Receiving setup needs **Zone Settings Write** (`zone-settings.write`), in addition to Email Routing Rules Write. The installer adds the missing scope to the existing OAuth client when it has OAuth Client Write; otherwise it prints the manual update instructions.
- Reconnect through **Domains → Add domain → Connect with Cloudflare** and approve the new scope. Existing grants do not gain permissions automatically.
- API-token connections need **Zone Settings Edit** for the selected mail zones.
- No database migration or new secrets. Mail already configured continues using its existing bindings.

### From 2.4.5 and earlier to 2.4.6

- The installer generates `BOXOX_SIGNING_SECRET`. `AGENT_JWT_SECRET` now signs agent credentials only; every other key derives from the new secret. Nothing to do by hand.
- Webhook signing secrets created before this release were stored in plain text. The five-minute recovery job re-encrypts them a batch at a time; existing endpoints keep receiving signed events throughout.
- Tracking links in mail sent before this release were signed under the old derivation and no longer resolve. New mail is unaffected.
- No database migration.
