# Box Ox 2.4.9

Released October 25, 2026.

This is a security maintenance release. It refuses Node.js versions without the October 21, 2026 security fixes and clears three high-severity dependency advisories. There is no database migration, new secret, or change to approved agent access. SDK 0.2.0, CLI 0.3.0, and email skill 0.5.0 keep their published bytes.

## Patched Node.js only

Node.js 22.23.4, 24.22.1, and 26.12.1 fix ten vulnerabilities. Four are rated high: a Brotli decoder out-of-bounds write in `node:zlib` (CVE-2026-111497) and hostname-check bypasses in `tls` and `dns` (CVE-2026-105482, CVE-2026-105483, CVE-2026-106069). The deployed app runs on Cloudflare's runtime, not Node.js. Node.js runs the installer, the CLI, the SDK, and builds.

- The `engines` range is now `^22.23.4 || ^24.22.1 || >=26.12.1`. The earlier `>=22.23.4` still accepted unpatched 24.x and 26.x releases and the unsupported 25.x line.
- `.npmrc` sets `engine-strict=true`, so `pnpm install` stops on an unpatched Node.js instead of printing a warning.
- `.nvmrc` pins Node.js 22.23.4. CI reads it. Workers Builds reads it too, so Deploy to Cloudflare installations no longer build on that service's default Node.js 24.21.0, which lacks the fixes. Leave the Node.js version setting in Workers Builds unset.

Check `node -v` before upgrading. If `pnpm install` reports `ERR_PNPM_UNSUPPORTED_ENGINE`, update Node.js to a patched release.

## Dependency advisories

- **zod** before 4.6.6 (GHSA-mrhx-c7xc-m3w5) can exhaust memory while validating a large array. No 3.x release has the fix, so the Worker and shared packages move to zod 4.6.7. Request validation keeps the same limits and defaults. Some validation error messages use zod 4's wording.
- **undici** before 7.30.1 (GHSA-xjj6-f33q-929c), used by local Wrangler development, is raised to 7.30.1.
- **body-parser** 2.0 to 2.3 (GHSA-27r3-jxmh-p828), used by the MCP SDK, is raised to 2.4.0.

The OpenAPI document at `docs/api/openapi.json` is now generated with zod's own JSON Schema export. It adds date-time and email patterns and integer bounds. Objects that accept and discard unknown fields no longer claim to reject them. The generated SDK types are unchanged.

## Upgrade and verification

Upgrade the existing installation with its current account, URL, owner, and plan. Use Node.js 22.23.4, 24.22.1, 26.12.1, or a newer release on those lines. No new permission or reconnection is needed.

Typecheck, the web build, the OpenAPI check, 514 Worker tests, the Free profile tests, the CLI, SDK, and package tests, the deployment script tests, the privacy scan, and `pnpm audit --audit-level high` pass on this source. A pnpm install was confirmed to stop on Node.js 24.22.0 and to succeed on 22.23.4, 24.22.1, and 26.12.1.

This release does not claim a fresh-account installation, new mail-delivery certification, populated-mail recovery, or throughput verification. It is unsigned. Published SHA-256 checksums establish download consistency, not independent publisher identity.
