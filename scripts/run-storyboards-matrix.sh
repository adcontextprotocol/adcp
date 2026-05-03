#!/usr/bin/env bash
# Run the per-tenant storyboard matrix locally and gate on the same floors
# CI uses. Mirrors .github/workflows/training-agent-storyboards.yml — keep
# the (tenant, min_clean, min_passed) tuples below in sync if CI floors move.
#
# Used by the pre-push hook (.husky/pre-push) when changes touch
# server/src/training-agent/** or static/compliance/source/**. Total runtime
# is ~3 minutes — too slow for pre-commit, fine for pre-push.

set -uo pipefail

# Mirror CI's overlay step before running tenants: copies in-repo
# compliance source onto the SDK's bundled cache so the runner grades
# against current-PR fixtures, not the SDK-published snapshot. Without
# this, edits under static/compliance/source/ would silently no-op
# locally and only surface in CI.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${SCRIPT_DIR}/overlay-compliance-cache.sh" || true

# tenant:min_clean:min_passed — kept in sync with the matrix.include block in
# .github/workflows/training-agent-storyboards.yml.
TENANTS=(
  "signals:65:23"
  "sales:62:212"
  "governance:63:66"
  "creative:56:69"
  "creative-builder:52:51"
  "brand:65:14"
)

REGRESSED=0
SUMMARY=""

for entry in "${TENANTS[@]}"; do
  tenant="${entry%%:*}"
  rest="${entry#*:}"
  min_clean="${rest%%:*}"
  min_passed="${rest##*:}"

  echo ""
  echo "──────────────────────────────────────────────"
  echo "Storyboards · /${tenant}  (floors: ${min_clean} clean, ${min_passed} steps)"
  echo "──────────────────────────────────────────────"

  log=$(mktemp -t "storyboards-${tenant}.XXXXXX.log")

  TENANT_PATH="${tenant}" \
    PUBLIC_TEST_AGENT_TOKEN="${PUBLIC_TEST_AGENT_TOKEN:-storyboard-local-token}" \
    npx tsx server/tests/manual/run-storyboards.ts > "${log}" 2>&1 || true

  clean=$(grep -oE 'storyboards: [0-9]+/[0-9]+' "${log}" | tail -1 | grep -oE '^storyboards: [0-9]+' | grep -oE '[0-9]+$' || echo "")
  passed=$(grep -oE 'steps: [0-9]+ passed' "${log}" | tail -1 | grep -oE '[0-9]+' || echo "")

  if [ -z "${clean}" ] || [ -z "${passed}" ]; then
    echo "::error::Failed to parse storyboard counts from runner output for /${tenant}."
    echo "  Log: ${log}"
    tail -40 "${log}"
    REGRESSED=1
    SUMMARY="${SUMMARY}\n  /${tenant}: ✗ parse failure (see ${log})"
    continue
  fi

  status="✓"
  failed_floor=""
  if [ "${clean}" -lt "${min_clean}" ]; then
    status="✗"
    failed_floor="clean storyboards ${clean} < ${min_clean}"
  fi
  if [ "${passed}" -lt "${min_passed}" ]; then
    status="✗"
    if [ -n "${failed_floor}" ]; then
      failed_floor="${failed_floor}; passing steps ${passed} < ${min_passed}"
    else
      failed_floor="passing steps ${passed} < ${min_passed}"
    fi
  fi

  echo "  ${status} clean=${clean} passed=${passed}"

  if [ "${status}" = "✓" ]; then
    rm -f "${log}"
    SUMMARY="${SUMMARY}\n  /${tenant}: ✓ ${clean} clean, ${passed} steps"
  else
    REGRESSED=1
    SUMMARY="${SUMMARY}\n  /${tenant}: ✗ ${failed_floor} (log: ${log})"
    echo ""
    echo "  --- last 40 lines of runner output ---"
    tail -40 "${log}"
  fi
done

echo ""
echo "══════════════════════════════════════════════"
echo "Storyboard matrix summary"
echo "══════════════════════════════════════════════"
printf '%b\n' "${SUMMARY}"
echo ""

if [ "${REGRESSED}" -ne 0 ]; then
  echo "✗ One or more tenants regressed below floor — push blocked."
  echo "  Floors are mirrored from .github/workflows/training-agent-storyboards.yml."
  echo "  To bypass for a known-good lift (e.g. you intentionally raised a floor),"
  echo "  pass --no-verify or update the floors in both this script and the workflow."
  exit 1
fi

echo "✓ All tenants meet floors."
