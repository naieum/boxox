# Uninstall Box Ox

Keep mail by default. Move incoming mail before removing its destination Worker.
This guide applies to Free and Paid installations.

## Let your agent remove it

Copy this prompt into your coding agent. Add your installation address if you know it.

```uninstall-prompt
Help me uninstall my Box Ox installation.
Read https://boxox.dev/uninstall-agent.md and follow its removal procedure.
First identify my exact Cloudflare account, installation address, and resources.
If the target is unclear, ask me which installation before making changes.
Preserve my mail by default. Show a removal plan and ask what data I want to keep.
Wait for my approval of the exact resources and any permanent data deletion.
Verify replacement mail delivery before removing incoming mail routes.
Preserve shared resources, unrelated DNS records, and account subscriptions.
Use authorized CLI/API access. Do not request control of my personal browser.
```

The prompt starts a review. It does not authorize permanent mail deletion.

## 1. Review the installation

1. Confirm the Cloudflare account and installation address.
2. Read the generated deployment configuration and inspect the live bindings.
3. Record resource IDs, mail routes, Access applications, OAuth clients, and deployment pipelines.
4. Mark each resource as exclusive, shared, or unknown.
5. Present the plan and the mail-retention choice before any changes.

Resource names alone do not prove ownership. Keep shared or unknown resources.
The deployment helper can reuse resources that existed before installation.

Newer source checkouts include a local inventory command:

```sh
node scripts/plan-uninstall.mjs --config .wrangler/deploy/wrangler.json
```

This command reads local configuration. It does not contact Cloudflare or delete anything.
Older releases require a manual inventory from that configuration.

## 2. Export and stop work

1. Stop applications and agents from submitting new work.
2. Cancel scheduled sends and decide whether to finish or discard pending work.
3. Export every mailbox that the owner wants to keep.
4. Follow every export cursor and check the manifest for missing originals.
5. Verify retained attachments and required R2 objects before removing storage.
6. Pause deployment pipelines, queue delivery, scheduled triggers, and Workflow instances after the mail handoff below.

[Backups and retention](https://boxox.dev/docs/backups/) covers export limits and recovery.
A single export response can contain only part of a mailbox.
D1 Time Travel does not replace a verified off-account backup.
FTS5 tables prevent ordinary D1 SQL export from providing a complete backup of this app.

## 3. Move incoming mail

If the installation has no mail domains, skip this section.

1. Choose a replacement mail provider or destination with the owner.
2. Configure its mailboxes and review the exact DNS changes.
3. Apply approved mail DNS changes, then test incoming mail at the replacement.
4. Remove only routing rules and catch-all actions that target this installation.
5. Remove its sending configuration and delivery-event subscriptions if no other application needs them.

Do not disable domain-wide Email Routing when another application uses it.
Preserve shared SPF includes, DKIM selectors, DMARC policies, and unrelated DNS records.
Box Ox does not provide an automatic restore of previous mail-provider DNS.
Use a saved DNS backup and the replacement provider's current instructions.

Cloudflare manages sending and receiving separately.
Its domain-removal actions can remove mail DNS records.
Review [Cloudflare's domain-removal procedure](https://developers.cloudflare.com/email-service/configuration/domains/) before applying changes.

## 4. Revoke access

1. Use **Domains → Add domain → Disconnect** for each saved Cloudflare connection.
2. Confirm revocation in Cloudflare if the disconnect reports a revocation failure.
3. Revoke this installation's agent grants, API keys, and webhook integrations.
4. Remove its private OAuth client after confirming that no other installation uses it.
5. Remove installer-created setup credentials and dedicated provider keys.

Keep temporary administrative access until cleanup and verification finish.
Do not revoke a shared Wrangler login or a credential used by another application.

## 5. Remove approved resources

Permanent deletion can destroy mail and runtime state. Get approval for the exact resource list first.

1. Verify retained backups and replacement mail delivery.
2. After the mail handoff, export and verify any mail that arrived during migration.
3. Remove the installation's external mail routes, subscriptions, and deployment triggers before removing the Worker.
4. Remove approved Workflow instances, workflows, queue consumers, queues, and dead-letter queues in dependency order.
5. Remove the approved Worker, its custom hostname mapping, and installation-only Access applications and policies.
6. Remove dedicated D1, R2, KV, search indexes, and analytics resources only after explicit data-deletion approval.
7. Revoke the temporary cleanup credential and remove local credentials or source files only if requested.

After removing the Access applications, check their dedicated reusable policies. Remove only unused policies that belong to this installation.

Wrangler OAuth can lack Access administration permissions. A successful app list can omit applications that it cannot read.
Compare the list with saved application IDs. If access fails, hand off those exact applications to the owner for dashboard cleanup.

Worker deletion can also delete its Durable Object namespaces and their state.
Review the delete operation's entire cascade before execution.
Keeping D1 and R2 does not preserve every runtime resource.
Retained storage and backups can continue to incur charges.

Keep the Cloudflare account, domains, nameservers, account-wide workers.dev registration, and shared Zero Trust organization.
Do not cancel Workers, R2, AI Gateway, or other account subscriptions as part of app removal.
Ask separately if the owner wants to review those charges.

## 6. Verify removal

1. Confirm that the removed app no longer serves Box Ox on any configured hostname.
2. Confirm that no mail rule, queue consumer, event subscription, or deployment pipeline targets the removed Worker.
3. Check that revoked grants cannot access the installation.
4. Verify replacement mail delivery again, if applicable.
5. List retained data, failed cleanup steps, and any continuing charges.

For a no-domain test installation, report mail-delivery checks as not applicable.
Do not report full removal when resources or active integrations remain without explanation.

## Tested removal

The agent procedure removed an empty 2.4.0 installation from a fresh Workers Free account on October 19, 2026.
All declared app, storage, queue, Workflow, and Durable Object resources disappeared from the live inventories.
The two dedicated Access apps and their unused policies also disappeared. Seven old app endpoints returned 404.
CLI/API calls removed the app resources. The authorized dashboard handled Access cleanup.

Account subscriptions, the shared Zero Trust organization, workers.dev registration, and both Wrangler profiles remained.

This installation had no mail domain or stored mail. The test did not cover populated-mail recovery or mail-provider migration.
