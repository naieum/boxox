# Contributing to Box Ox

Read the [README](README.md), [setup guide](docs/setup.md), and [license](LICENSE) first.
The application uses FSL-1.1-MIT. The SDK and CLI use MIT licenses.

## Local setup

Use Node.js 22 or later and pnpm 10.25.0. Install the locked dependencies:

```sh
pnpm install --frozen-lockfile
pnpm --filter @boxox/mail build
```

Follow the setup guide for local Worker bindings and Cloudflare Access. Protected local routes require a valid Access identity. Use synthetic mail in tests and screenshots.

## Checks

Run the checks relevant to your change. GitHub Actions runs the full verification workflow.

```sh
pnpm typecheck
pnpm --filter @boxox/web build
pnpm test --concurrency=1
node --test scripts/test/deploy-*.test.mjs scripts/test/plan-uninstall.test.mjs
pnpm --filter @boxox/worker exec vitest run --config vitest.free.config.ts
```

Before publishing source or generated downloads:

```sh
node scripts/install-gitleaks.mjs
python3 scripts/check-release-privacy.py --tracked
```

The marketing website source and its build tools are maintained separately.
This repository contains the mail application, developer tools, and application documentation.

## Proposing a change

Open a focused pull request. Describe the behavior that changes, the reason, and the checks you ran. Include screenshots for interface changes. Do not include credentials, installation identifiers, private mail, local state, or customer data.

The `main` branch requires a pull request, the passing `verify` check, and resolved review conversations.
Keep the branch current before merging. Force pushes and branch deletion are disabled, including for administrators.

After merging changes to `main`, publish the Free template from a clean, reviewed checkout:

```sh
node scripts/publish-free-template.mjs --publish
```

The command preserves the complete workspace and updates the generated `deploy-free` branch without force pushes.
It records the source commit in `.boxox-template.json`. Do not edit the generated branch directly.
The Free template keeps `wrangler.paid.jsonc` for full-suite tests and a reviewed upgrade.

Report security vulnerabilities privately to **hello@boxox.dev**. Send the affected version and a safe reproduction.
Keep secrets and sensitive message content out of reports. Do not open a public issue containing an exploit or private data.
