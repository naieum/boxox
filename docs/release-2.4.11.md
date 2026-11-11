# Box Ox 2.4.11

Released November 11, 2026.

This release makes Quarantine reachable in the app and adds a **Mark as spam** button. Install it instead of 2.4.10: that release sends more phishing to Quarantine, and until now the app had no way to open that folder. There is no database migration, new secret, new setting, or change to approved agent access. SDK 0.2.0, CLI 0.3.0, and email skill 0.5.0 keep their published bytes.

## Quarantine is a folder

Mail with a phishing score of 80% or more goes to Quarantine, where its links are turned off. Before this release the folder was missing from the navigation and the thread list returned nothing for it, so quarantined mail could only be found by search. No mail was deleted: anything quarantined earlier appears in the folder after you upgrade.

- **Quarantine** is in the sidebar under Spam.
- A quarantined conversation has **Not phishing: move to inbox**, **Block sender** and **Delete**. Moving it to the inbox also trains the filter that it was legitimate.
- **Why is this in Quarantine?** lists the phishing signs, as before.

## Mark as spam

Conversations in the inbox have a **Mark as spam** button. It moves the conversation to Spam, trains the Bayes filter, and records the campaign fingerprint so a later copy is caught. Until now the only way to do this from the app was **Block sender**, which also blocks the address.

## Upgrade and verification

Upgrade the existing installation with its current account, URL, owner, and plan, as the [upgrade guide](https://boxox.dev/docs/upgrade/) describes. The phishing rules and the rescan of recent inbox mail are described in the [2.4.10 release notes](https://boxox.dev/docs/releases/2.4.10/). After upgrading, look in Quarantine and Spam for mail the rescan moved.

Typecheck, the web build, 521 Worker tests, the Free profile tests, the CLI, SDK, and package tests, the deployment script tests, the privacy scan, and `pnpm audit --audit-level high` pass on this source. The new buttons and folder were not exercised in a signed-in browser session.
