# Box Ox 2.4.3

Released October 19, 2026.

## Source privacy

Examples and tests now use synthetic Cloudflare account IDs, generic Workers hostnames, and relative paths. Experimental spike code and internal audit prose are excluded from source downloads.

Source ZIPs for 2.0.0 through 2.4.2 have been withdrawn. Their download URLs return 410 and link to the current release. Original manifests and checksums remain as historical records; they do not mean a withdrawn artifact is still available. Each affected release directory includes `withdrawal.json`.

The SDK 0.2.0, CLI 0.2.0, email skill 0.4.0 and other reviewed packages retain their published bytes. Required copyright and third-party notices remain.

## Publication checks

The site build and tool-package build scan generated files and ZIP/TGZ members before publication. Pinned Gitleaks checks credentials. Additional rules check personal infrastructure identifiers, personal email addresses, local home paths, and private configuration filenames. Reviewed secret fixtures use exact source-line hashes and paths; test directories are not exempt.

Contributors install the scanner once and check tracked files:

```sh
node scripts/install-gitleaks.mjs
python3 scripts/check-release-privacy.py --tracked
```

At publication, the website build checked the complete generated site and release archives. The website source and these build checks are now maintained separately. A missing scanner, unreadable archive, or exceeded scan limit blocks publication. These checks reduce accidental exposure. They cannot identify every possible personal detail.

## Verification limits

This release changes distribution privacy and publication checks. It does not establish a new fresh-account installation, mail round trip, or throughput result. Existing installations do not need a mail-runtime redeployment for these changes.
