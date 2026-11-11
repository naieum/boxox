#!/usr/bin/env bash
# pnpm run deploy   (BOXOX_URL=https://mail.example.com for a custom address)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or set aside uncommitted project files before deploying so /health identifies the deployed source." >&2
  exit 1
fi
echo "Deployment health is verified separately from owner sign-in and mail delivery. Complete the installation checks in docs/setup.md."

# Sign-in and the one install question come first, while you are at the keyboard;
# the builds then run unattended.
node scripts/prepare-deploy.mjs
boxox_deploy_dir="${BOXOX_DEPLOY_DIR:-.wrangler/deploy}"
trap 'rm -f "$boxox_deploy_dir/initial-secrets.json"' EXIT
pnpm --filter @boxox/mail build
pnpm -r --if-present typecheck
pnpm --filter @boxox/web build
pnpm exec wrangler d1 migrations apply DB --remote --config "$boxox_deploy_dir/wrangler.json"
boxox_sha="$(git rev-parse HEAD)"
boxox_deploy_args=(--config "$boxox_deploy_dir/wrangler.json" --keep-vars --var "BUILD_SHA:$boxox_sha")
for boxox_setting in INGEST_MAX_CONCURRENCY AGENT_SEND_LIMIT_PER_15_MIN SEARCH_BODY_CHAR_LIMIT INDEX_ATTACHMENT_TEXT; do
  boxox_setting_value="${!boxox_setting:-}"
  if [[ -n "$boxox_setting_value" ]]; then boxox_deploy_args+=(--var "$boxox_setting:$boxox_setting_value"); fi
done
if [[ -f "$boxox_deploy_dir/initial-secrets.json" ]]; then
  boxox_deploy_args+=(--secrets-file "$boxox_deploy_dir/initial-secrets.json")
fi
pnpm exec wrangler deploy "${boxox_deploy_args[@]}"

boxox_deploy_url="$(BOXOX_DEPLOY_DIR="$boxox_deploy_dir" node --input-type=module -e 'import{readFileSync}from"node:fs";process.stdout.write(JSON.parse(readFileSync((process.env.BOXOX_DEPLOY_DIR??".wrangler/deploy")+"/wrangler.json","utf8")).vars.PUBLIC_URL)')"
boxox_health=0
if [[ -n "$boxox_deploy_url" ]]; then
  BOXOX_URL="$boxox_deploy_url" BOXOX_EXPECTED_SHA="$boxox_sha" node --input-type=module <<'JS' || boxox_health=$?
// A successful upload can precede propagation of the new version at this edge, and a
// hostname created by this run can take a few minutes to resolve and get its certificate.
const deadline = Date.now() + 300_000;
let told = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(new URL('/health', process.env.BOXOX_URL), { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    const body = await response.json();
    if (response.ok && body.ok === true && body.version === process.env.BOXOX_EXPECTED_SHA) {
      console.log(`Verified deployment ${body.version.slice(0, 12)}\n\nBox Ox is installed at ${process.env.BOXOX_URL}`);
      process.exit(0);
    }
  } catch { /* Retry transient propagation/network failures within the deadline. */ }
  if (!told && Date.now() > deadline - 280_000) { told = true; console.log(`Waiting for ${process.env.BOXOX_URL} to answer. A new address can take a few minutes.`); }
  await new Promise(resolve => setTimeout(resolve, 2_000));
}
console.error(`\nThe app was uploaded, but ${process.env.BOXOX_URL}/health did not report this version within five minutes.\nA new address can take longer to start answering, and this computer may remember that it did not exist a moment ago.\nOpen ${process.env.BOXOX_URL}/health in a browser shortly; it should show commit ${process.env.BOXOX_EXPECTED_SHA.slice(0, 12)}.`);
process.exit(3);
JS
fi
# The owner's first sign-in: a single-use link, unless Cloudflare Access is in front
# or the owner already has a passkey.
node scripts/owner-link.mjs --if-needed
# An unanswered health check is reported after the owner link, never instead of it.
exit "$boxox_health"
