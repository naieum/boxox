#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "--local" || "$#" != 1 ]]; then
  echo 'Usage: bash skills/boxox-email/e2e.sh --local' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
pnpm --filter @boxox/cli build
node skills/boxox-email/scripts/e2e.mjs
