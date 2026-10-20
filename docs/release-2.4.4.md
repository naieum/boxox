# Box Ox 2.4.4

Released October 19, 2026.

## Installation wording

Box Ox installs with a scripted deploy: download the source, run `pnpm run deploy`, configure Cloudflare Access, then finish domain setup at `/setup`. There is no Deploy to Cloudflare button, because the source is distributed from boxox.dev rather than a public Git repository. Site pages and configuration comments no longer imply one.

The internal V2 planning document, which described a Deploy button, is excluded from source downloads.

## Verification limits

This release changes documentation and source packaging only. Application code, migrations, SDK 0.2.0, CLI 0.2.0 and email skill 0.4.0 are unchanged from 2.4.3. It does not establish a new fresh-account installation, mail round trip, or throughput result. Existing installations do not need to redeploy.
