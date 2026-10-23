# Connect with Cloudflare

Box Ox can connect to Cloudflare without asking the owner to copy an API token.
The owner approves access in Cloudflare. Box Ox encrypts the credentials in its D1 database and renews access automatically.

## Installation

The installer creates a private OAuth client when its deployment credential has **OAuth Client Write**.
The client belongs to the installation's Cloudflare account.
It uses Authorization Code with PKCE and one exact callback URL.
No client secret or Wrangler login credential is stored in the Worker.

If the deployment login lacks that permission, create the client once in **Cloudflare → Manage account → OAuth clients**:

| Setting | Value |
| --- | --- |
| Response type | Code |
| Grant types | Authorization Code, Refresh Token |
| Token authentication | None (PKCE) |
| Redirect URL | `https://YOUR-INSTALLATION/api/cloudflare/callback` |
| Visibility | Private |

Select these scopes:

| Profile | Required scopes |
| --- | --- |
| Free | `zone.read`, `dns.write`, `zone-settings.write`, `email-routing-rule.write` |
| Paid | Free scopes plus `email-sending.write`, `queues.write` |

Cloudflare adds `offline_access` for refresh tokens.

**Zone Settings Write is required for receiving.** Email Routing Rules Write only
manages rules; it does not authorize routing settings, DNS activation, or plus
addressing. Cloudflare requires `zone-settings.write` for those operations.
See [enable routing](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/)
and [update routing settings](https://developers.cloudflare.com/api/resources/email_routing/methods/edit/).

### Upgrade an existing connection

Rerun the installer. It checks the configured OAuth client and adds missing client
scopes when the deployment credential has OAuth Client Write. If it reports a
permission error, edit the existing client in Cloudflare and add **Zone Settings
Write** (`zone-settings.write`); retain its client ID, callback, and other scopes.
Then deploy the updated Worker and reconnect through **Domains → Add domain →
Connect with Cloudflare**. Updating the client or Worker does not expand an
existing owner's grant: the owner must approve the new scope in Cloudflare.
API-token connections need **Zone Settings Edit** on the mail zones as well.

Deploy with `CF_OAUTH_CLIENT_ID` set to the resulting client ID.
The client ID is public configuration, not a credential.
Existing Worker configuration is preserved on later deployments.

A normal Wrangler login cannot register this client unless Cloudflare grants it OAuth Client Write.
The installer reports that limitation instead of copying Wrangler's broad, expiring credentials into the app.
An installation agent can prepare the client; the account owner must approve the access Cloudflare requests.

## Add a domain

1. Open **Domains → Add domain → Connect with Cloudflare**.
2. Approve access in Cloudflare.
3. Choose a domain and review its mail records.
4. Confirm the changes.

Connecting does not change DNS.
Replacing another mail provider's records requires a separate confirmation.
Free installations can receive mail; Paid installations can also send it.

**Disconnect** removes the stored credentials and attempts to revoke the refresh token at Cloudflare.
If Cloudflare cannot be reached, revoke the application in Cloudflare's Authorized Applications page.
Other mail features keep working after disconnecting.

## Credential handling

Only the installation owner can connect or disconnect Cloudflare.
Credentials are bound to that owner, organization, account, and OAuth client.
The encryption key derives from the installation's signing secret with a separate purpose label.
Rotating that signing secret requires reconnecting Cloudflare.

Authorization state expires after ten minutes and uses an encrypted HttpOnly cookie.
The callback checks the owner and state before exchanging a code.
A D1 lease prevents simultaneous requests from rotating the same refresh token.
Revoked refresh tokens fail closed and require another Cloudflare approval.

A scoped API token remains available under **Advanced**.
That fallback expires from the browser after fifteen minutes.
Initial setup's optional AI Gateway configuration still uses its existing setup credential; this domain connection does not grant AI Gateway administration.

## References

- [Cloudflare OAuth applications](https://developers.cloudflare.com/fundamentals/oauth/)
- [OAuth client registration and permissions](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Authorization endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
