# Box Ox 2.5.1

Released November 20, 2026.

This is a security maintenance release. It updates Hono, the web framework inside the Worker, past five advisories published on November 12, 2026, raises three development dependencies, and refuses Node.js versions without the November 2026 security fixes. There is no database migration, new secret, new setting, or change to approved agent access. SDK 0.2.0, CLI 0.3.0, and email skill 0.5.0 keep their published bytes.

Upgrade to get the fixes. An installation on 2.5.0 or earlier keeps the older Hono until it is upgraded.

## What reached Box Ox

One of the five Hono advisories applies to this app (GHSA-h7mg-cq63-vhpq). For a request path containing an encoded line break, such as `%0A`, Hono's default router matched no wildcard middleware. Box Ox attaches sign-in checks and security headers as wildcard middleware.

- **No protected page or API answered without its sign-in check.** Each route handler still ran every check registered for it. This was tested against the affected version with the same middleware layout as the app.
- **The not-found response skipped the middleware.** A path that matched no route returned the `404` response, or the public app shell, without the security headers.

Hono 4.13.19 applies the middleware in both cases.

The other four advisories are in features Box Ox does not use: `mount()` (GHSA-4m76-xfj5-7975), the `csrf()` middleware (GHSA-46wx-v44x-9hh2), `validator('form')` (GHSA-4h7h-rv7c-7m2v) and the `css` helper (GHSA-3gg2-335m-rxc6).

## Development dependencies

None of these run in the deployed Worker.

- **Vite** 6.4.4 (GHSA-8g5g-mxqh-grgj) let a query string bypass `server.fs.deny` on the local development server. It is raised to 6.4.6.
- **@hono/node-server** before 2.1.3 (GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w) and **fast-uri** before 3.1.9 (GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp) are installed by the MCP SDK and are not imported by the Worker. They are raised to 2.1.11 and 3.1.9.

`pnpm audit` reports one remaining low-severity advisory: esbuild 0.27.4's development server can read files on Windows (GHSA-g7r4-m6w7-qqqr). Box Ox uses esbuild only to bundle the CLI and never starts that server.

## Patched Node.js only

Node.js 22.23.5, 24.22.3, and 26.13.1 were published on November 10 and 11, 2026. They fix several high-severity flaws in the Node.js HTTPS and HTTP/2 servers, including CVE-2026-123864, and update the bundled llhttp, undici and sqlite. The deployed app runs on Cloudflare's runtime, not Node.js, and Box Ox does not run a Node.js server. Node.js runs the installer, the CLI, the SDK, and builds.

- The `engines` range is now `^22.23.5 || ^24.22.3 || >=26.13.1`.
- `.nvmrc` pins Node.js 22.23.5. CI and Workers Builds read it.

Check `node -v` before upgrading. If `pnpm install` reports `ERR_PNPM_UNSUPPORTED_ENGINE`, update Node.js to a patched release.

## Checked and not affected

- **Malicious npm packages.** No package in the lockfile is named in an npm malware advisory that GitHub published between October 20 and November 20, 2026. That includes this month's WPPConnect releases and the keyv and cacheable packages, none of which Box Ox installs.
- **pnpm CVE-2026-130756.** It affects the standalone pnpm executable, which bundles its own Node.js. Box Ox's instructions and CI run pnpm 10.25.0 through Corepack on the installed Node.js. If you installed pnpm as a standalone executable, update it.

## Upgrade and verification

Upgrade the existing installation with `pnpm run deploy`. Use Node.js 22.23.5, 24.22.3, 26.13.1, or a newer release on those lines. No new permission or reconnection is needed.

Typecheck, the web build, 529 Worker tests, the Free profile tests, the CLI, SDK, and package tests, the deployment script tests, the privacy scan, and `pnpm audit --audit-level high` pass on this source with Node.js 22.23.5. A pnpm install was confirmed to stop on Node.js 26.12.1 and to succeed on 22.23.5.

This release does not claim a fresh-account installation, new mail-delivery certification, populated-mail recovery, or throughput verification. It is unsigned. Published SHA-256 checksums establish download consistency, not independent publisher identity.
