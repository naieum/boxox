# Deliverability tools

Box Ox checks domain configuration and tracks mail events. Cloudflare handles SMTP delivery. Recipient providers decide whether a message reaches the inbox.

## Monitoring

Box Ox checks up to five active mail domains each hour, oldest first. Larger installations rotate through their domains over several hours.

The Domains dashboard shows the latest result and five recent problem or recovery alerts. The owner’s Domains navigation badge flags current DNS problems or known listings. Open **Domains** and select **Check now** for a fresh check.

Alerts appear in the app. Box Ox does not email these alerts or submit blocklist removal requests.

## DNS checks

Box Ox queries public DNS for SPF, DKIM, DMARC, and receiving MX records. It uses the sending selector and return path saved by the last check when available.

A missing or invalid required record flags the domain. DNS errors remain unknown. A DMARC record with `p=none` is valid monitoring, but it does not enforce rejection.

Before changing DMARC to `quarantine` or `reject`, verify every legitimate sender. The check does not change your policy automatically.

## BIMI

The optional check reads `default._bimi` for the domain. It checks the record format, HTTPS URLs, and the domain’s DMARC enforcement policy.

To configure BIMI:

1. Verify that all legitimate mail passes aligned SPF or DKIM.
2. Review DMARC reports before enforcing your policy.
3. Publish a DMARC policy at enforcement for the domain and its organizational domain.
4. Prepare a logo in the required SVG Tiny P/S format.
5. Get a mark certificate if your target mailbox providers require one.
6. Host the logo and certificate over HTTPS.
7. Publish the BIMI TXT record.
8. Verify the configuration with your target mailbox providers.

Box Ox does not download or validate logo files or certificates. It does not verify the parent-domain policy or guarantee logo display. It does not issue VMCs or CMCs.

Use the [BIMI Group implementation guide](https://bimigroup.org/implementation-guide/) for current requirements.

## Reputation

Sender-domain checks use Spamhaus DBL. They require **reputation lookups** to be on and your own `SPAMHAUS_DQS_KEY` secret. Spamhaus terms and query limits apply.

The check sends the domain through Cloudflare DNS-over-HTTPS using your DQS key. It sends no message body. Lookup failures do not establish a clean result. A known listing remains flagged until a later check returns clear.

If listed, review the result with Spamhaus. Box Ox does not remove listings automatically. It does not scan every blocklist or monitor Cloudflare’s entire sending IP pool.

Inbound reputation filters are separate. They can use Cloudflare’s security resolver, OpenPhish, and optional Spamhaus IP and domain checks.

## Suppressions

Hard bounces and spam complaints add recipients to the sending domain’s suppression list. Box Ox checks this list before sending. The developer API can list, add, and remove entries with the required domain-key permissions.

## Sending safeguards

Box Ox pauses sending when recent delivery outcomes exceed its safety thresholds:

- Bounce rate: 5%.
- Complaint rate: 1%.
- Minimum sample: 20 delivery outcomes over seven days.

Review the cause before resuming sending.

## Delivery events

Message logs track individual delivery events. Signed webhooks let your application receive those events and verify the payload signature.

See the [API reference](https://boxox.dev/docs/api/) for event handling, signatures, retries, and suppression endpoints.

## Cloudflare delivery

Cloudflare Email Service signs outgoing mail and handles transport. Box Ox does not offer managed dedicated sending IPs, IP warmup, or selectable SMTP delivery regions. These require provider support.

The Worker’s edge location does not establish the email’s SMTP sending region. Box Ox does not promise a delivery latency or inbox placement rate.

Read [Cloudflare’s Postmaster documentation](https://developers.cloudflare.com/email-service/reference/postmaster/) for transport details.
