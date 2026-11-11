# Box Ox 2.4.10

Released November 11, 2026.

This release closes a gap in phishing detection. A message that poses as your mail system, sent from a domain that passes SPF, DKIM and DMARC and linking to a login page on a reputable file host, was delivered to the inbox. Every earlier 2.x release is affected, and a new mailbox most of all. There is no database migration, new secret, new setting, or change to approved agent access. SDK 0.2.0, CLI 0.3.0, and email skill 0.5.0 keep their published bytes.

## What got through

The message was a "Password Reset" notice from "Mail Admin" at a throwaway domain. It said the mailbox password would expire and linked to a page on an object-storage host, with the recipient's address encoded in the link. The sender had set up authentication correctly, so the message earned credit for passing DMARC. Its link domain was on no block list. No local rule read the subject or body, the Bayes filter had no training yet, and the spam score was 6.5%.

Turning AI on would not have caught it. With "only when uncertain" on, a score that low skips the classifier. When the classifier does run, its influence is capped so that it cannot flag mail alone.

## New local rules

These run with **Local filters** on. They need no AI and send nothing outside your Cloudflare account. None of them applies to mail from your own domains.

| Signal | Fires when |
|---|---|
| `mailbox_credential_lure` | The subject or body is a notice about the mailbox itself (its password, storage, suspension, or held mail) and the message has a link or attachment |
| `lure_names_recipient` | That notice also names the recipient's address or your domain |
| `recipient_in_link` | A link carries the recipient's address in its fragment, or base64-encoded anywhere. The plain address in a query string, as unsubscribe links have, is ignored |
| `storage_hosted_page` | A link points to an HTML page on object storage |
| `display_name_role` | The display name poses as the mail system or its staff, such as "Mail Admin" or "Webmail Support" |
| `subject_names_recipient` | The subject contains the recipient's address |
| `obfuscated_sender_text` | The subject or display name has hidden characters, or a word that mixes Latin with Greek or Cyrillic letters |

## Two kinds of phishing sign send mail to Spam

Before this release mail left the inbox only when the spam score passed 50% or the phishing score passed 80%. On a new mailbox that takes a rule score few phishing messages reach. Now two different kinds of phishing sign with a combined weight of 5 send a message to Spam. One kind is never enough, and the AI scores do not count toward it. Quarantine still needs a phishing score of 80%.

Two changes reduce false positives:

- Each kind of phishing sign counts once in the phishing score.
- At most two link-text mismatches count in the rule score. A newsletter whose links all pass through one click tracker is no longer scored as many separate mismatches.

**Why is this in spam?** names the phishing signs when they are the reason.

## Mail delivered before the upgrade

After you upgrade, Box Ox scores the last 30 days of inbox mail again with the new rules. It runs hourly in batches of 25 messages, or 5 on the Free profile, and moves what it finds to Spam or Quarantine. No AI model is called and nothing is sent outside your account. Mail you marked **Not spam** is left alone, and so is everything outside the inbox.

Mark any phishing you find as spam. That trains the Bayes filter and records the campaign fingerprint, which is what catches the next copy.

## Measured results

On the public evaluation corpus (4,150 legitimate, 1,896 spam and 1,303 phishing messages), with rules only and no training:

| | 2.4.9 | 2.4.10 |
|---|---:|---:|
| Phishing kept out of the inbox | 60 (4.6%) | 440 (33.8%) |
| Phishing sent to Quarantine | 1 | 111 |
| Legitimate mail flagged | 9 | 5 |

The legitimate mail in this corpus dates from 2002 and contains no modern marketing mail, so it is weak evidence about false positives. Two thirds of phishing still reaches the inbox of a mailbox with no training. With the Bayes filter trained on your own spam and not-spam choices, the same corpus reaches 91.6% recall. The method and its limits are in `docs/model-eval.md`.

## What this does not change

- **Local filters** must be on. With them off, Box Ox does no spam or phishing screening at all.
- Reputation lookups and AI stay as you set them.
- The cap on the AI classifier's influence and the "only when uncertain" switch are unchanged.
- Box Ox does not check for new releases. Compare `/health` on your mail hostname with the [releases page](https://boxox.dev/releases/).

## Upgrade and verification

Upgrade the existing installation with its current account, URL, owner, and plan, as the [upgrade guide](https://boxox.dev/docs/upgrade/) describes. No new permission or reconnection is needed.

Typecheck, the web build, 520 Worker tests, the Free profile tests, the CLI, SDK, and package tests, the deployment script tests, the privacy scan, and `pnpm audit --audit-level high` pass on this source.
