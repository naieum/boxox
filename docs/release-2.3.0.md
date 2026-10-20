# Box Ox 2.3.0

## Connect with Cloudflare

Choose **Domains → Add domain → Connect with Cloudflare**.
Approve access in Cloudflare, then choose a domain and review its mail records.
No API token copying is required for a configured OAuth installation.

Box Ox encrypts the authorization in D1 and renews access automatically.
**Disconnect** removes the saved authorization and attempts revocation at Cloudflare.
The advanced fifteen-minute token connection remains available.

The installer registers a private, installation-owned OAuth client when its credential has OAuth Client Write.
Otherwise, the installation agent or owner must register the client once.
Read [Cloudflare connection setup](/docs/cloudflare-connection/) for the exact settings.
Initial setup’s optional AI Gateway administration still uses its setup credential.

Free installations request receiving and DNS permissions.
Paid installations also request sending and delivery-event queue permissions.
Replacing another provider’s mail records still requires confirmation.

## Verification

The live Cloudflare approval, token exchange, encrypted storage, and account-filtered domain list passed on the existing Paid installation.
Tests cover automatic renewal, concurrent refresh, revocation, owner and account isolation, cross-site rejection, and Free-profile scopes.
A native Worker fetch regression is also covered.

No new domain’s mail records were changed for this check.
Live refresh after token expiry and a fresh Free-account installation were not tested.
