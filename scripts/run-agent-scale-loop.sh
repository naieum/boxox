#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Optional repair executable receives the unit id and a feedback-file path.
# It must start a fresh coding-agent context. No shell eval or implicit paid API calls.
repair="${BOXOX_SCALE_REPAIR:-}"
mode="${1:---audit}"
if [[ "$mode" == "--dry-run" ]]; then mode=--audit; fi
ids=()
while IFS= read -r id; do ids+=("$id"); done < <(node --input-type=module -e 'import fs from "node:fs"; for(const u of JSON.parse(fs.readFileSync("scripts/agent-scale-worklist.json"))) console.log(u.id)')
passed=0
failed=0
for id in "${ids[@]}"; do
  [[ "$mode" == "--audit" || "$mode" == "$id" ]] || continue
  feedback=".loops/runs/agent-scale/$id.feedback"
  mkdir -p "$(dirname "$feedback")"
  success=0
  for attempt in 1 2 3; do
    if node scripts/verify-agent-scale.mjs "$id" >"$feedback" 2>&1; then success=1; break; fi
    cat "$feedback" >&2
    [[ -n "$repair" && "$attempt" -lt 3 ]] || break
    "$repair" "$id" "$PWD/$feedback"
  done
  if [[ "$success" == 1 ]]; then
    passed=$((passed+1))
  else
    failed=$((failed+1))
    UNIT="$id" node --input-type=module -e 'import fs from "node:fs"; fs.appendFileSync(".loops/runs/agent-scale/quarantine.jsonl",JSON.stringify({id:process.env.UNIT,at:new Date().toISOString(),reason:"behavioral verifier failed; inspect unit log"})+"\n")'
  fi
done
echo "$passed passed; $failed quarantined; mode=$mode; no commits or deployments performed"
[[ "$passed" -gt 0 || "$failed" -gt 0 ]] || exit 2
[[ "$failed" == 0 ]]
