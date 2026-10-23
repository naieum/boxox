# Box Ox 2.4.7

Released October 23, 2026.

This release fixes a receiving-domain setup failure after a successful Cloudflare connection. Sending could work while **Send and receive** failed with a generic permission error. There is no database migration or new secret. SDK 0.2.0, CLI 0.2.0, and email skill 0.4.1 are unchanged.

## Receiving permission

Box Ox requested **Email Routing Rules Write**, which authorizes routing rules, but omitted **Zone Settings Write** (`zone-settings.write`). Cloudflare requires the latter to read and enable Email Routing settings and configure plus addressing. Both Free and Paid OAuth connections now request it.

The installer updates a matching existing client instead of creating a duplicate. Configured client IDs, callback URLs, and other permissions stay in place. If the deployment credential lacks OAuth Client Write, the installer explains how to update the client manually.

The domain setup error now names the missing permission and explains reconnection and API-token alternatives. Receiving setup checks routing-settings access before removing a previous provider's DNS records. A zone without existing routing settings can still be enabled.

## Upgrade

Run the installer from this release with the same account, owner, URL, and plan. Then reconnect through **Domains → Add domain → Connect with Cloudflare** and approve the new permission. Updating the client registration does not expand an existing owner's grant automatically.

If the installer reports missing OAuth Client Write, edit the existing client in Cloudflare, add **Zone Settings Write**, and retain its client ID and callback. API tokens need **Zone Settings Edit** for the selected zones. The app's token instructions and setup guide now include this permission.

Previously configured mail continues working through its existing bindings. Reconnection is needed to use the corrected domain-onboarding permissions.

## Verification and limits

Regression tests cover settings-read and activation permission failures, no DNS changes after a rejected settings preflight, first-time routing setup, and upgrades of configured and discovered OAuth clients. Deployment verification checks the source commit reported by `/health`.

The maintainer's Paid installation has verified outbound delivery, replies, both configured addresses, and plus addressing, with SPF, DKIM, and DMARC passing at the external recipient. Its receiving routes were configured manually before this release; those checks do not establish a fresh-account OAuth onboarding test. No fresh-account installation, populated-mail recovery, or throughput verification is claimed for this release.

This release is unsigned. Published SHA-256 checksums establish download consistency, not independent publisher identity.
