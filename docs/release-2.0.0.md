# Box Ox 2.0.0

Released October 18, 2026. Self-published at https://boxox.dev/.

- Downloadable Cloudflare application with workers.dev or optional custom app hosting.
- Private owner app protected by Cloudflare Access; scoped developer keys and OAuth/MCP agent access.
- Sending and receiving on Cloudflare DNS domains, with DNS previews and explicit MX replacement confirmation.
- Domains can be added after initial setup without reopening the setup wizard.
- Successful API sends appear in the Inbox and Sent view. Developer delivery logs and signed webhooks remain available.
- Standalone CLI, installable CLI tarball, typed SDK tarball, and an application integration skill, all hosted directly on boxox.dev.
- AI remains off until explicitly enabled; local filtering, reputation, and AI have separate controls.

## Installation and verification

Use https://boxox.dev/setup/ or give your agent https://boxox.dev/install-agent.md.
Release metadata and SHA-256 checksums are under https://boxox.dev/downloads/.
Versioned copies are under https://boxox.dev/downloads/v2.0.0/.

Installation was exercised with isolated resources in an existing Workers Paid account. This is not a brand-new-account acceptance test.
Each installer must configure owner Access, a scoped temporary setup token, and mail domains, then verify their own mail round trip.
Cloudflare account limits and service terms apply. One-click installation is not claimed.

The release is unsigned. Same-site checksums establish download consistency, not independent maintainer identity.
The application is FSL-1.1-MIT. The CLI and SDK are MIT licensed.
