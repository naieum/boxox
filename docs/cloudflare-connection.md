# Connect with Cloudflare

**This is optional.** A normal installation connects mail domains from the installer's computer with
`pnpm run domain example.com`, and the app holds no Cloudflare credential at all.
See [Connect a mail domain](https://boxox.dev/docs/connect-domain/).

Use this page only if you want to add domains from inside the app instead. That needs an OAuth client registered in
your own Cloudflare account, so the app can ask you for access on Cloudflare's page. Box Ox ships no shared client:
nothing about your installation depends on its publisher.

## Register your client

Create it once in **Cloudflare → Manage account → OAuth clients**. Cloudflare's sign-in for tools cannot create OAuth
clients, so this step is done in the dashboard.

| Setting | Value |
| --- | --- |
| Response type | Code |
| Grant types | Authorization Code, Refresh Token |
| Token authentication | None (PKCE) |
| Redirect URL | `https://YOUR-INSTALLATION/api/cloudflare/callback` |
| Visibility | Private |

Then deploy with `CF_OAUTH_CLIENT_ID` set to its client ID. The ID is public configuration, not a credential,
and later deployments keep it. No client secret or Wrangler login credential is stored in the Worker.

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

### Change an existing client

If the app reports a missing permission, edit the client in Cloudflare and add it; keep its client ID, callback and
other scopes. Then reconnect through **Domains → Add domain → Connect with Cloudflare**. Changing the client does not
expand an existing grant: the owner must approve the new scope in Cloudflare.
API-token connections need **Zone Settings Edit** on the mail zones as well.

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
This connection does not grant AI Gateway administration; see the [processing guide](https://boxox.dev/docs/processing/) for enabling AI.

## References

- [Cloudflare OAuth applications](https://developers.cloudflare.com/fundamentals/oauth/)
- [OAuth client registration and permissions](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Authorization endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
