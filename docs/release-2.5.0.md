# Box Ox 2.5.0

Released November 11, 2026.

Installing Box Ox no longer involves creating or pasting any API token, or configuring Cloudflare Access. You run one command, allow Wrangler (Cloudflare's own deployment tool) if the computer is not signed in, and open the link the installer prints. Box Ox registers no application with Cloudflare and contacts no service run by its publisher, so an installation never depends on anyone but its owner and Cloudflare.

There is one database migration (`0010_owner_signin`), applied by the installer. SDK 0.2.0, CLI 0.3.0, and email skill 0.5.0 keep their published bytes.

## What installing looks like now

```sh
pnpm install --frozen-lockfile
pnpm run deploy
pnpm run domain example.com
```

- **No settings to type.** The installer finds your account and uses your Cloudflare sign-in's email as the owner. Upgrades read the owner, address and plan from the installed Worker.
- **One question.** Cloudflare's sign-in for tools cannot read billing, so a first install asks whether the account is on Workers Free or Workers Paid. `BOXOX_PLAN` answers it in advance.
- **Still Cloudflare's own step:** R2 has to be switched on in the dashboard once, with a payment method, before a first install.

## Sign in with a passkey

New installations sign people in with passkeys instead of Cloudflare Access.

- The installer prints a single-use link. Opening it creates the owner's passkey and signs you in. It expires in 24 hours. Anyone who has it can become the owner, so keep it to yourself.
- `pnpm run owner-link` makes a new link. It needs your Cloudflare sign-in, so the Cloudflare account stays the root of control, and it is how you get back in if you lose every passkey.
- **Settings → Sign-in** lists your passkeys, adds one for another device, and lets the owner invite or remove people. An invited person sees no mail until you grant them an address.
- The database stores public keys and SHA-256 digests of session cookies and unused links. None of that can sign anyone in.

**Existing installations keep Cloudflare Access.** If your Worker has `ACCESS_AUD` and `TEAM_DOMAIN`, nothing about sign-in changes and no link is printed. Access remains supported for anyone who prefers it; the setup guide has the steps.

## Connect a mail domain with one command

`pnpm run domain example.com` turns on Email Routing and, on Workers Paid, Email Sending and delivery events, using your Cloudflare sign-in on the installing computer. It shows what it will do and asks first. The app no longer needs a Cloudflare credential for this, so there is no setup token to create or remove.

If the domain already receives mail at another provider, the command stops and lists the MX and SPF records in the way. It cannot edit DNS: you delete those records in the Cloudflare dashboard and run it again. That is deliberate. Moving a domain's mail is your decision.

## What still needs a token

- **Turning AI on.** Box Ox sets privacy and spending limits on your AI Gateway before any mail reaches a model, and Wrangler's sign-in cannot change AI Gateway. Enabling AI needs an API token limited to AI Gateway Edit, stored while you make the change. AI stays off unless you choose it.
- **Adding domains from inside the app** (instead of the command) still works with your own OAuth client or a scoped token, as before. It is optional.

## How this was checked

- 529 Worker tests, 8 Free-profile tests and 56 installer and site tests pass, with typecheck and the web build.
- **A real first install.** The release source was installed as a second, separate installation in an existing Workers Paid account, on a custom address, with only the address and the plan given. It created its own database, storage, queues, search index and Worker. The owner opened the installer's link, created a passkey on a real device and signed in.
- **A real first domain.** `pnpm run domain` then connected a domain that had no mail records, using Wrangler's sign-in only. Cloudflare reports Email Routing ready, the catch-all pointing at the new Worker, Email Sending DNS ready and the delivery-event subscription enabled.
- That install found one fault, fixed in this release: on a brand-new address the installer's health check gave up after 60 seconds and stopped before printing the owner link. It now waits up to five minutes and always prints the link.
- An existing installation that uses Cloudflare Access was upgraded with nothing typed; Access sign-in was left unchanged.
- Passkey sign-in was also run in a browser against a local copy with a simulated device: reuse of the owner link refused, sign-out, sign-in, inviting a second person, and that person being refused owner settings.

Not run for this release: a Cloudflare account that has never used Workers or R2, the Workers Free profile on a real account, a domain that already has another provider's mail records, a mail round trip on the new installation, and the Deploy to Cloudflare button.

## Upgrade

Follow the [upgrade guide](https://boxox.dev/docs/upgrade/): check out 2.5.0 and run `pnpm run deploy`. No settings need repeating.
