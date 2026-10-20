#!/usr/bin/env bash
# CF_ACCOUNT_ID=... OWNER_EMAIL=you@example.com BOXOX_URL=https://mail.example.com pnpm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or set aside uncommitted project files before deploying so /health identifies the deployed source." >&2
  exit 1
fi
echo "Deployment health is verified separately from owner sign-in and mail delivery. Complete the Access and installation checks in docs/setup.md."

pnpm exec wrangler whoami
pnpm --filter @boxox/mail build
pnpm -r --if-present typecheck
pnpm --filter @boxox/web build
node scripts/prepare-deploy.mjs
boxox_deploy_dir="${BOXOX_DEPLOY_DIR:-.wrangler/deploy}"
trap 'rm -f "$boxox_deploy_dir/initial-secrets.json"' EXIT
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
if [[ -n "$boxox_deploy_url" ]]; then
  BOXOX_URL="$boxox_deploy_url" BOXOX_EXPECTED_SHA="$boxox_sha" node --input-type=module <<'JS'
// A successful upload can precede propagation of the new version at this edge.
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(new URL('/health', process.env.BOXOX_URL), { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
    const body = await response.json();
    if (response.ok && body.ok === true && body.version === process.env.BOXOX_EXPECTED_SHA) {
      console.log(`Verified deployment ${body.version.slice(0, 12)}`);
      process.exit(0);
    }
  } catch { /* Retry transient propagation/network failures within the deadline. */ }
  await new Promise(resolve => setTimeout(resolve, 1_000));
}
throw new Error('Deployed /health did not report this source commit within 60 seconds');
JS
fi
