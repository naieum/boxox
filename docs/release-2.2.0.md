# Box Ox 2.2.0

## Add domains from the app

Choose **Domains → Add domain**.
If Cloudflare is disconnected, the owner can paste a scoped API token in the dialog.
No Worker secret change is required for this flow.

The connection expires after 15 minutes.
Box Ox keeps the credential encrypted in a Secure, HttpOnly browser cookie.
It binds the connection to the owner, installation account, and organization.
**Disconnect** removes the browser cookie.

Choose a domain, inspect its mail records, and select sending or receiving.
Free installations offer receiving only.
Replacing an existing provider’s mail records still requires explicit confirmation.
Connecting Cloudflare only checks access and does not change DNS.

## Verification

Tests cover owner and account isolation, tampered and expired connections, cross-site rejection, credential handling, and DNS replacement confirmation.
Browser checks cover the dialog, record preview, confirmation controls, keyboard dismissal, and mobile layout.
Live onboarding of another domain still requires the owner’s scoped token and domain choice.
