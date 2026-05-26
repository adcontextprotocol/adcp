#!/usr/bin/env bash
# Run the per-tenant storyboard matrix locally and gate on the same floors
# CI uses. Mirrors .github/workflows/training-agent-storyboards.yml — keep
# the (tenant, min_clean, min_passed) tuples below in sync if CI floors move.
#
# Used by the pre-push hook (.husky/pre-push) when changes touch
# server/src/training-agent/** or static/compliance/source/**. Total runtime
# is ~3 minutes — too slow for pre-commit, fine for pre-push.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OVERLAY=1
COMPLIANCE_DIR=""
LABEL="current compliance source"
FLOOR_SET="current"
RELEASE_BASE_REF="${ADCP_RELEASE_BASE_REF:-origin/3.0.x}"
if [[ "${RELEASE_BASE_REF}" != */* ]]; then
  RELEASE_GIT_REF="origin/${RELEASE_BASE_REF}"
else
  RELEASE_GIT_REF="${RELEASE_BASE_REF}"
fi
export ADCP_RELEASE_GIT_REF="${RELEASE_GIT_REF}"

usage() {
  cat <<'USAGE'
Usage: scripts/run-storyboards-matrix.sh [options]

Options:
  --skip-overlay                 Do not copy static/compliance/source into the SDK cache.
  --compliance-dir <dir>         Run against an explicit compliance bundle directory.
  --latest-3.0                   Run against the latest released dist/compliance/3.0.x bundle.
  -h, --help                     Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-overlay)
      OVERLAY=0
      shift
      ;;
    --compliance-dir)
      if [ -z "${2:-}" ]; then
        echo "::error::--compliance-dir requires a directory argument"
        exit 1
      fi
      COMPLIANCE_DIR="$2"
      LABEL="released compliance bundle: ${COMPLIANCE_DIR}"
      FLOOR_SET="released"
      OVERLAY=0
      shift 2
      ;;
    --latest-3.0)
      latest_3_0=$(node - <<'NODE' "$REPO_ROOT"
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const gitRef = process.env.ADCP_RELEASE_GIT_REF || 'origin/main';
function listFromGit(ref) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-tree', '-d', '--name-only', `${ref}:dist/compliance`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).filter((name) => /^3\.0\.\d+$/.test(name));
  } catch {
    return [];
  }
}
function listFromWorkingTree() {
  const dir = path.join(root, 'dist', 'compliance');
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^3\.0\.\d+$/.test(name))
    : [];
}
const versions = listFromGit(gitRef);
if (versions.length === 0) {
  versions.push(...listFromWorkingTree());
}
versions.sort((a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
});
const latest = versions.at(-1);
if (!latest) {
  process.exit(2);
}
process.stdout.write(latest);
NODE
)
      if [ -z "${latest_3_0}" ]; then
        echo "::error::No dist/compliance/3.0.x bundle found"
        exit 1
      fi
      if git -C "${REPO_ROOT}" cat-file -e "${RELEASE_GIT_REF}:dist/compliance/${latest_3_0}/index.json" 2>/dev/null; then
        bundle_tmp=$(mktemp -d -t "storyboards-3-0-compat.XXXXXX")
        git -C "${REPO_ROOT}" archive "${RELEASE_GIT_REF}" "dist/compliance/${latest_3_0}" | tar -x -C "${bundle_tmp}"
        COMPLIANCE_DIR="${bundle_tmp}/dist/compliance/${latest_3_0}"
        if git -C "${REPO_ROOT}" cat-file -e "${RELEASE_GIT_REF}:dist/schemas/${latest_3_0}/index.json" 2>/dev/null; then
          git -C "${REPO_ROOT}" archive "${RELEASE_GIT_REF}" "dist/schemas/${latest_3_0}" | tar -x -C "${bundle_tmp}"
          bash "${SCRIPT_DIR}/stage-sdk-schema-bundle.sh" "${bundle_tmp}/dist/schemas/${latest_3_0}" "${latest_3_0}"
        fi
      else
        COMPLIANCE_DIR="${REPO_ROOT}/dist/compliance/${latest_3_0}"
        if [ -f "${REPO_ROOT}/dist/schemas/${latest_3_0}/index.json" ]; then
          bash "${SCRIPT_DIR}/stage-sdk-schema-bundle.sh" "${REPO_ROOT}/dist/schemas/${latest_3_0}" "${latest_3_0}"
        fi
      fi
      LABEL="released compliance bundle: ${latest_3_0}"
      FLOOR_SET="3.0-compat"
      OVERLAY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "::error::Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [ -n "${COMPLIANCE_DIR}" ]; then
  if [ "${COMPLIANCE_DIR#/}" = "${COMPLIANCE_DIR}" ]; then
    COMPLIANCE_DIR="${REPO_ROOT}/${COMPLIANCE_DIR}"
  fi
  if [ ! -f "${COMPLIANCE_DIR}/index.json" ]; then
    echo "::error::Compliance bundle not found at ${COMPLIANCE_DIR}"
    exit 1
  fi
  export ADCP_COMPLIANCE_DIR="${COMPLIANCE_DIR}"
  bundle_version=$(node - <<'NODE' "${COMPLIANCE_DIR}"
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
process.stdout.write(index.adcp_version || '');
NODE
)
  if [[ "${bundle_version}" =~ ^3\.0\.[0-9]+$ ]]; then
    FLOOR_SET="3.0-compat"
  fi
fi

if [ "${OVERLAY}" -eq 1 ]; then
  # Mirror CI's overlay step before running tenants: copies in-repo
  # compliance source onto the SDK's bundled cache so the runner grades
  # against current-PR fixtures, not the SDK-published snapshot. Without
  # this, edits under static/compliance/source/ would silently no-op
  # locally and only surface in CI.
  bash "${SCRIPT_DIR}/overlay-compliance-cache.sh"
else
  echo "Skipping compliance source overlay (${LABEL})."
fi

# tenant:min_clean:min_passed — kept in sync with the matrix.include block in
# .github/workflows/training-agent-storyboards.yml.
if [ "${FLOOR_SET}" = "3.0-compat" ]; then
  TENANTS=(
    "signals:65:94"
    "sales:65:272"
    "governance:65:135"
    "creative:65:137"
    "creative-builder:65:121"
    "brand:65:80"
  )
else
  TENANTS=(
    "signals:74:111"
    "sales:74:380"
    "governance:73:151"
    "creative:73:169"
    "creative-builder:70:146"
    "brand:73:96"
  )
fi

REGRESSED=0
SUMMARY=""
REQUIRED_CLEAN_CURRENT_SALES=(
  "media_buy_seller/canonical_formats"
)

storyboard_passed() {
  local storyboard_id="$1"
  local log_file="$2"
  awk -v id="${storyboard_id}" '
    $0 ~ "^[[:space:]]+" id "([[:space:]]|$)" {
      if ($0 ~ /[[:space:]]✓[[:space:]]/) {
        found = 1
        exit 0
      }
      if ($0 ~ /[[:space:]]✗[[:space:]]/) {
        exit 1
      }
      in_storyboard = 1
      next
    }
    in_storyboard && $0 ~ /^[[:space:]]*✓[[:space:]]/ {
      found = 1
      exit 0
    }
    in_storyboard && $0 ~ /^[[:space:]]*✗[[:space:]]/ {
      exit 1
    }
    in_storyboard && $0 ~ /^[[:space:]]+[[:alnum:]_\/-]+[[:space:]]/ {
      exit 1
    }
    END {
      if (found) exit 0
      exit 1
    }
  ' "${log_file}"
}

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

  if [ "${FLOOR_SET}" = "current" ] && [ "${tenant}" = "sales" ]; then
    for storyboard_id in "${REQUIRED_CLEAN_CURRENT_SALES[@]}"; do
      if storyboard_passed "${storyboard_id}" "${log}"; then
        echo "  ✓ required-clean ${storyboard_id}"
      else
        status="✗"
        if [ -n "${failed_floor}" ]; then
          failed_floor="${failed_floor}; required-clean ${storyboard_id} did not pass"
        else
          failed_floor="required-clean ${storyboard_id} did not pass"
        fi
      fi
    done
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
echo "Storyboard matrix summary (${LABEL})"
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
