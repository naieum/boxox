# Box Ox 2.0.1

## Added

- Scheduled domain checks, up to five active domains each hour, oldest first.
- In-app DNS problem and recovery alerts, with an owner navigation badge.
- Optional Spamhaus DBL checks for sending domains, using existing reputation consent and the owner’s DQS key.
- BIMI DNS-format checks and setup guidance.
- A homepage feature section in place of the code example.

## Fixed

- Duplicate or malformed DMARC policies no longer pass the domain check.
- Spamhaus DNS failures no longer appear as clean results.
- A failed reputation query does not clear the last known listing.

## Installation

Use the current [project download](https://boxox.dev/downloads/boxox-v2.zip) and [release metadata](https://boxox.dev/downloads/release.json).

For an existing installation, review the changes and run `pnpm run deploy` from the new source. Keep your existing resource configuration and credentials. No database migration is required for these features.

The scheduler checks domains at minute 15 each hour. Check **Domains** after deployment, or select **Check now**. Public health responses still expose only aggregate DNS status.

BIMI checks cover DNS format and local DMARC prerequisites. They do not validate logo files, certificates, or parent-domain policy. Dedicated IPs and SMTP region selection are not Box Ox features.

Read the [deliverability guide](https://boxox.dev/docs/deliverability/) for setup and limits. The original 2.0.0 downloads remain unchanged under their versioned URLs.
