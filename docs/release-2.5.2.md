# Box Ox 2.5.2

Released November 25, 2026.

On November 24, 2026 Cloudflare made Email Sending available on the Workers Free plan, limited to an account's own verified addresses. This release handles the new send refusal that comes with it and brings the documentation in line with the new plan rule. There is no database migration, new secret, new setting, or change to approved agent access. SDK 0.2.0, CLI 0.3.0, and email skill 0.5.0 keep their published bytes.

## What Cloudflare changed

- **Email Sending works on Workers Free.** An account on Workers Free can turn on Email Sending for a domain and send through the Workers binding, the REST API or SMTP. It reaches only the [verified destination addresses](https://developers.cloudflare.com/email-service/configuration/destination-addresses/) in that account.
- **Any other recipient is refused.** If one address in `to`, `cc` or `bcc` is not verified, Cloudflare rejects the whole message. The Workers binding reports `E_RECIPIENT_PLAN_RESTRICTED`.
- **Verified addresses cost nothing.** Sends to them are free on both plans and do not count toward the 3,000 monthly messages or the daily limit.
- **Verified addresses get delivery events.** Mail from a sending domain to a verified destination address now counts as Email Sending traffic, with delivered and bounced events.

Sending to anyone else still requires Workers Paid. See Cloudflare's [announcement](https://developers.cloudflare.com/changelog/post/2026-11-24-email-sending-workers-free/) and [pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

## What changed in Box Ox

**A plan refusal is now a failure, not an unknown delivery.** Box Ox treats a send error it does not recognise as possibly delivered, because resending such a message could deliver it twice. It did not recognise `E_RECIPIENT_PLAN_RESTRICTED`. A mailbox or developer API message refused for that reason was recorded as "Delivery unknown: the message may have been sent" although nothing had left Cloudflare.

Those messages are now marked failed. The stored error says that nothing was sent and what to do: switch the Cloudflare account to Workers Paid, or verify the recipient under Email Service in Cloudflare. The test send on the setup page shows the same instruction. Agent sends already recorded this refusal as a failure.

**Who can see this.** Only a full install whose Cloudflare account is on Workers Free. The installer cannot read your plan, so on a first install it asks. Cloudflare now lets a Workers Free account turn on Email Sending for a domain, and a test send to your own verified address succeeds there. The first sign of a wrong answer is a refused message to someone else.

## What did not change

- **The inbox install on Workers Free still does not send.** Cloudflare's free sending reaches only your own verified addresses. Sending from Box Ox needs the full install on Workers Paid. `pnpm run domain` on the inbox install still sets up receiving only.
- **Delivery events need no change.** Events for mail to your verified addresses arrive on the same queue as every other delivery event, and Box Ox matches them to the message as before.
- **The sending quota shown in Domains** comes from Cloudflare's own count.

## Documentation

- [Requirements and Cloudflare costs](https://boxox.dev/docs/requirements/) and the [Workers Free guide](https://boxox.dev/docs/free/) state the plan rule and what a wrong plan answer looks like.
- The [troubleshooting guide](https://boxox.dev/docs/troubleshooting/) explains `E_RECIPIENT_PLAN_RESTRICTED` under Email Service diagnosis. The agent installation runbook tells an installing agent that a passing test send does not prove the plan.
- The [comparison with Cloudflare Email Service](https://boxox.dev/compare/cloudflare-email-service/) lists free sending to verified addresses on Cloudflare's side. Its sources were checked again on November 25, 2026.
- The README cost table has the same rule.

## Upgrade and verification

Upgrade the existing installation with `pnpm run deploy`. No new permission or reconnection is needed.

Typecheck, the web build, 530 Worker tests, the Free profile tests, the CLI, SDK, and package tests, the deployment script tests, the privacy scan, and `pnpm audit --audit-level high` pass on this source with Node.js 26.13.1.

The refusal was tested with a simulated binding error carrying Cloudflare's documented code. It was not reproduced on a Workers Free account, and delivery events for verified addresses were not observed on a live installation for this release.

This release does not claim a fresh-account installation, new mail-delivery certification, populated-mail recovery, or throughput verification. It is unsigned. Published SHA-256 checksums establish download consistency, not independent publisher identity.
