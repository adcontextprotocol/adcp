#!/usr/bin/env bash
# Run the per-tenant storyboard matrix locally and gate on the same floors
# CI uses. Mirrors .github/workflows/training-agent-storyboards.yml — keep
# the (tenant, min_clean, min_passed) tuples below in sync if CI floors move.
#
# The pre-push hook runs it through scripts/run-storyboards-prepush.sh when
# changes touch the training agent, the compliance source or these scripts.
#
# Every training-agent process (each single-process tenant, and each
# discovery and storyboard child of the isolated tenants) runs from one queue,
# scripts/run-storyboards-queue.mjs, at most ADCP_STORYBOARD_JOBS at a time
# (1 runs them one after another). Tenants are then graded here, one by one in
# the order below, from their logs.
#
# Phases, for the queue: --prepare <state-dir> builds and selects the bundles
# and writes the tenant plan; --grade <state-dir> grades the tenant logs.
# Without either, the script runs all three phases itself.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Storyboard processes share compiled schema validators and schema-root
# document identities through @adcp/sdk's opt-in on-disk cache, so only the
# first process compiles them. The tenant plan carries the variable to every
# training-agent process the queue starts, for this script and for
# run-storyboards-3-0-compat.sh, which runs through it. Each worktree keeps its
# own cache; set the variable to another absolute path to move it, or to an
# empty string to turn the cache off.
export ADCP_VALIDATOR_CACHE_DIR="${ADCP_VALIDATOR_CACHE_DIR-${REPO_ROOT}/node_modules/.cache/adcp-sdk-validators}"

MODE="run"
STATE_DIR=""
for ((arg_index = 1; arg_index <= $#; arg_index += 1)); do
  case "${!arg_index}" in
    --prepare|--grade)
      MODE="${!arg_index#--}"
      next_index=$((arg_index + 1))
      STATE_DIR="${!next_index:-}"
      if [ -z "${STATE_DIR}" ] || [ ! -d "${STATE_DIR}" ]; then
        echo "::error::${!arg_index} requires an existing state directory"
        exit 1
      fi
      ;;
  esac
done

queue_pid=""
cleanup_run_state() {
  # The queue owns a prepared state directory; a full run owns its own.
  if [ "${MODE}" = "run" ] && [ -n "${STATE_DIR}" ] && [ -d "${STATE_DIR}" ]; then
    rm -rf "${STATE_DIR}"
  fi
}
trap cleanup_run_state EXIT
stop_queue() {
  trap - INT TERM HUP
  if [ -n "${queue_pid}" ]; then
    kill -TERM "${queue_pid}" 2>/dev/null
    wait "${queue_pid}" 2>/dev/null
  fi
  exit "$1"
}
trap 'stop_queue 130' INT
trap 'stop_queue 143' TERM
trap 'stop_queue 129' HUP
if [ "${MODE}" = "run" ]; then
  STATE_DIR=$(mktemp -d -t "storyboards-matrix-state.XXXXXX") || {
    echo "::error::mktemp failed while creating the matrix state directory"
    exit 1
  }
fi

CURRENT_SOURCE=1
COMPLIANCE_DIR=""
SCHEMA_ROOT="${ADCP_SCHEMA_ROOT:-}"
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
  --compliance-dir <dir>         Run against an explicit compliance bundle directory.
  --latest-3.0                   Run against the latest released dist/compliance/3.0.x bundle.
  --prepare <state-dir>          Only build and select the bundles and write the tenant plan
                                 (used by scripts/run-storyboards-queue.mjs).
  --grade <state-dir>            Only grade the tenant logs of a prepared, queued run.
  -h, --help                     Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prepare|--grade)
      shift 2
      ;;
    --compliance-dir)
      if [ -z "${2:-}" ]; then
        echo "::error::--compliance-dir requires a directory argument"
        exit 1
      fi
      COMPLIANCE_DIR="$2"
      LABEL="released compliance bundle: ${COMPLIANCE_DIR}"
      FLOOR_SET="released"
      CURRENT_SOURCE=0
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
        bundle_tmp=$(mktemp -d "${STATE_DIR}/3-0-compat.XXXXXX")
        git -C "${REPO_ROOT}" archive "${RELEASE_GIT_REF}" "dist/compliance/${latest_3_0}" | tar -x -C "${bundle_tmp}"
        COMPLIANCE_DIR="${bundle_tmp}/dist/compliance/${latest_3_0}"
        node "${SCRIPT_DIR}/patch-3-0-compat-bundle.cjs" "${COMPLIANCE_DIR}"
        if git -C "${REPO_ROOT}" cat-file -e "${RELEASE_GIT_REF}:dist/schemas/${latest_3_0}/index.json" 2>/dev/null; then
          git -C "${REPO_ROOT}" archive "${RELEASE_GIT_REF}" "dist/schemas/${latest_3_0}" | tar -x -C "${bundle_tmp}"
          SCHEMA_ROOT="${bundle_tmp}/dist/schemas/${latest_3_0}"
        fi
      else
        bundle_tmp=$(mktemp -d "${STATE_DIR}/3-0-compat.XXXXXX")
        mkdir -p "${bundle_tmp}/dist/compliance"
        cp -R "${REPO_ROOT}/dist/compliance/${latest_3_0}" "${bundle_tmp}/dist/compliance/${latest_3_0}"
        COMPLIANCE_DIR="${bundle_tmp}/dist/compliance/${latest_3_0}"
        node "${SCRIPT_DIR}/patch-3-0-compat-bundle.cjs" "${COMPLIANCE_DIR}"
        if [ -f "${REPO_ROOT}/dist/schemas/${latest_3_0}/index.json" ]; then
          SCHEMA_ROOT="${REPO_ROOT}/dist/schemas/${latest_3_0}"
        fi
      fi
      if [ -z "${SCHEMA_ROOT}" ]; then
        echo "::error::No dist/schemas/${latest_3_0} bundle found"
        exit 1
      fi
      LABEL="released compliance bundle: ${latest_3_0}"
      FLOOR_SET="3.0-compat"
      CURRENT_SOURCE=0
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

if [ "${MODE}" = "grade" ]; then
  # Grading reads the plan --prepare wrote; nothing is built or selected.
  # shellcheck source=/dev/null
  . "${STATE_DIR}/state.sh"
elif [ "${CURRENT_SOURCE}" -eq 1 ]; then
  echo "Building current compliance and schema bundles."
  # ADCP_STORYBOARD_TEST_SKIP_BUILDS is for this script's own tests (fake
  # runners); the pre-push path never sets it. Each build runs only when its
  # inputs changed, and a failed build stops the matrix. With the builds
  # skipped, ADCP_STORYBOARD_TEST_BUILT_DIST may name a directory that stands
  # in for dist/ (schemas/latest and compliance/latest), so the fake runs need
  # no real build; it is ignored unless the builds are skipped.
  BUILT_DIST="${REPO_ROOT}/dist"
  if [ "${ADCP_STORYBOARD_TEST_SKIP_BUILDS:-}" != "1" ]; then
    node "${REPO_ROOT}/scripts/built-schemas.cjs" ensure schemas || exit 1
    node "${REPO_ROOT}/scripts/built-schemas.cjs" ensure compliance || exit 1
  elif [ -n "${ADCP_STORYBOARD_TEST_BUILT_DIST:-}" ]; then
    BUILT_DIST="${ADCP_STORYBOARD_TEST_BUILT_DIST}"
  fi
  COMPLIANCE_DIR="${BUILT_DIST}/compliance/latest"
  if [ -z "${SCHEMA_ROOT}" ]; then
    # Snapshot the freshly built schema bundle. The SDK's schema loader
    # asserts that every schema id under the root matches the requested
    # version (or is a "latest" id pinned by the root index.json). A
    # concurrent `npm run build:schemas` in the same tree rewrites
    # dist/schemas/latest in place and leaves the root without its index for
    # a moment, which aborts a tenant mid-run with "does not match the
    # requested version ... found latest (latest)" (#7478). Reading from an
    # immutable copy keeps the run independent of later rebuilds.
    if [ ! -f "${BUILT_DIST}/schemas/latest/index.json" ]; then
      echo "::error::dist/schemas/latest was not built; cannot snapshot the schema root"
      exit 1
    fi
    schema_snapshot=$(mktemp -d "${STATE_DIR}/schema-root.XXXXXX") || {
      echo "::error::mktemp failed while creating the schema root snapshot"
      exit 1
    }
    cp -R "${BUILT_DIST}/schemas/latest/." "${schema_snapshot}/" || {
      echo "::error::Failed to snapshot dist/schemas/latest into ${schema_snapshot}"
      exit 1
    }
    SCHEMA_ROOT="${schema_snapshot}"
    echo "Schema root snapshot: ${SCHEMA_ROOT}"
  fi
fi

if [ "${MODE}" != "grade" ] && [ -n "${COMPLIANCE_DIR}" ]; then
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
  if [ -z "${SCHEMA_ROOT}" ]; then
    SCHEMA_ROOT=$(node - <<'NODE' "${COMPLIANCE_DIR}" "${bundle_version}" "${REPO_ROOT}"
const fs = require('node:fs');
const path = require('node:path');
const complianceDir = path.resolve(process.argv[2]);
const bundleVersion = process.argv[3];
const repoRoot = path.resolve(process.argv[4]);
const bundleName = path.basename(complianceDir);
const keys = [...new Set([bundleVersion, bundleName].filter(Boolean))];
const candidates = [];
const add = (candidate) => {
  if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
};

const complianceParent = path.dirname(complianceDir);
const distDir = path.dirname(complianceParent);
if (path.basename(complianceParent) === 'compliance' && path.basename(distDir) === 'dist') {
  const packageRoot = path.dirname(distDir);
  for (const key of keys) {
    add(path.join(packageRoot, 'dist', 'schemas', key));
    add(path.join(packageRoot, 'schemas', 'cache', key));
  }
}
for (const key of keys) {
  add(path.join(repoRoot, 'dist', 'schemas', key));
  add(path.join(repoRoot, 'schemas', 'cache', key));
}

const found = candidates.find(candidate => fs.existsSync(path.join(candidate, 'index.json')));
if (found) process.stdout.write(found);
NODE
)
  fi
  if [ -z "${SCHEMA_ROOT}" ]; then
    echo "::error::No matching schema bundle found for compliance bundle ${COMPLIANCE_DIR}. Set ADCP_SCHEMA_ROOT or use a co-located dist/schemas/<version> bundle."
    exit 1
  fi
  if [[ "${bundle_version}" =~ ^3\.0\.[0-9]+$ ]]; then
    FLOOR_SET="3.0-compat"
  fi
fi

if [ "${MODE}" != "grade" ] && [ -n "${SCHEMA_ROOT}" ]; then
  if [ "${SCHEMA_ROOT#/}" = "${SCHEMA_ROOT}" ]; then
    SCHEMA_ROOT="${REPO_ROOT}/${SCHEMA_ROOT}"
  fi
  if [ ! -f "${SCHEMA_ROOT}/index.json" ]; then
    echo "::error::Schema bundle not found at ${SCHEMA_ROOT}"
    exit 1
  fi
  export ADCP_SCHEMA_ROOT="${SCHEMA_ROOT}"
fi

if [ "${MODE}" != "grade" ]; then
  echo "Using explicit compliance and schema roots (${LABEL})."

  # One log per tenant, kept whether the tenant passes or fails, so a run's
  # per-storyboard rows can be compared with another run's. Each run of a
  # floor set overwrites that floor set's logs, so the directory never grows.
  LOG_DIR="${ADCP_STORYBOARD_LOG_DIR:-${REPO_ROOT}/test-results/storyboards}/${FLOOR_SET}"
  mkdir -p "${LOG_DIR}" && LOG_DIR="$(cd "${LOG_DIR}" && pwd)" || {
    echo "::error::Cannot create the storyboard log directory ${LOG_DIR}"
    exit 1
  }
fi

# tenant:min_clean:min_passed — kept in sync with the matrix.include block in
# .github/workflows/training-agent-storyboards.yml.
if [ "${FLOOR_SET}" = "3.0-compat" ]; then
  TENANTS=(
    # Capability-resolved 3.0.26 replay. N/A storyboards are selection rows,
    # not synthetic clean results, so these floors grade only executed rows.
    # SDK 15.9.5 skips webhook_emission/get_capabilities (http loopback
    # brand_json_url under the echoed 3.2 schema): one step fewer for
    # signals, governance and creative.
    "signals:24:97"
    # SDK 14 beta.12 marks unsigned signing-required functional steps N/A for
    # immutable bundles that predate the functional_dispatch contract.
    "sales:39:219"
    "governance:27:146"
    "creative:22:108"
    "creative-builder:24:112"
    "brand:22:76"
    "si:21:72"
  )
else
  TENANTS=(
    # Ratcheted from the first capability-resolved replay. The runner reports
    # declared-scope applicability and quarantines separately from these
    # clean-result-row and passing-step regression floors.
    # /brand and /governance do not implement validate_input. The corrected
    # CTV + premium-display gates remove 14 + 18 controller seed passes; all
    # validator checks previously skipped. Only subtract those 32 false-coverage
    # steps (115 -> 83, 160 -> 128); retain every clean/other/3.0-compat floor.
    "signals:45:80"
    # /sales ratcheted from the candidate-mode replay with the 3.3 hold
    # storyboards (#8182).
    "sales:191:1400"
    "governance:47:128"
    "creative:49:209"
    "creative-builder:50:184"
    "brand:45:83"
    "si:42:50"
  )
fi

REGRESSED=0
SUMMARY=""
REQUIRED_CLEAN_CURRENT_SALES=(
  "sales_non_guaranteed"
  "sales_guaranteed"
  "media_buy_seller/billing_finality_delivery"
  "media_buy_seller/canonical_formats"
  "media_buy_seller/external_audience_source_binding"
  "media_buy_seller/vendor_metric_catalog_precondition"
  "canonical_format_validate_input"
  "notification_config_event_scope"
  "notification_config_lifecycle"
  "notification_config_rejections"
  "wholesale_feed_products"
  "wholesale_feed_products_scope_isolation"
  "wholesale_feed_product_webhooks"
  "wholesale_feed_bulk_webhooks"
)
REQUIRED_EXACT_CURRENT_SALES=(
  # 9 steps since 1.1.0 added the assignment_operations check (#8933).
  "media_buy_seller/compact_direct_buy_lifecycle:9:0"
  "media_buy_seller/compact_product_lifecycle:10:0"
  "media_buy_seller/declined_proposal_refinement:7:0"
  "media_buy_seller/declined_proposal_execution:9:0"
  "media_buy_seller/expired_proposal_execution:9:0"
  "media_buy_seller/change_rights_state_projection:8:0"
  "media_buy_seller/acceptance_policy_discovery:4:0"
  "media_buy_seller/governance_agent_binding_acceptance:5:0"
  "media_buy_seller/external_audience_source_binding:9:0"
  "media_buy_seller/get_products_async:11:0"
  # requires: [multi_agent] storyboards routed to the governance tenant
  # (multiAgentRoutingForStoryboard). Exact counts prove the governed calls
  # executed; a routing regression collapses them to a skipped row.
  "media_buy_seller/governance_approved:13:0"
  "media_buy_seller/governance_conditions:12:0"
  "media_buy_seller/governance_denied:11:0"
  "media_buy_seller/governance_denied_recovery:10:0"
  # Experimental 3.3 account requests: exact counts pin the training agent's
  # deterministic branches (separate-account refusal, matched, buyer sign-up).
  "account_requests:36:3"
  # Experimental 3.3 reporting subscriptions over the sandbox clock.
  "media_buy_seller/reporting_subscription_coverage:46:1"
  "media_buy_seller/reporting_subscription_capacity:16:0"
  # Experimental 3.3 holds over seeded hold policies. The hold_extension
  # skips are the extend_hold steps the @adcp/sdk runner cannot send yet
  # (adcontextprotocol/adcp-client#3601) and their dependents.
  "media_buy_seller/hold_policy_bounds:18:0"
  "media_buy_seller/hold_policy_terms_only:19:4"
  "media_buy_seller/hold_policy_version_gate:11:0"
  "media_buy_seller/hold_unavailable_batch:12:0"
  "media_buy_seller/hold_extension:22:10"
  "media_buy_seller/hold_ranking:11:0"
)
REQUIRED_EXACT_CURRENT_GOVERNANCE=(
  "governance/failed_outcome_audit_persistence:4:0"
  "governance/budget_periods:7:0"
)
REQUIRED_CLEAN_CURRENT_SIGNALS=(
  "wholesale_feed_signals"
  "wholesale_feed_signal_webhooks"
  "wholesale_feed_bulk_webhooks"
)
REQUIRED_CLEAN_CURRENT_CREATIVE=(
  "canonical_format_validate_input"
  "creative/billing_out_of_band"
)
REQUIRED_CLEAN_CURRENT_CREATIVE_BUILDER=(
  "canonical_format_validate_input"
)
# Routed requires: [multi_agent] governance storyboards, one per governed
# tenant other than sales (see REQUIRED_EXACT_CURRENT_SALES).
REQUIRED_EXACT_CURRENT_SIGNALS=(
  "signal_marketplace/governance_approved:7:0"
)
REQUIRED_EXACT_CURRENT_BRAND=(
  "brand_rights/governance_approved:7:0"
)
REQUIRED_EXACT_CURRENT_CREATIVE_BUILDER=(
  "creative_transformers/governance_approved:6:0"
)
REQUIRED_CLEAN_CURRENT_SI=(
  "si_baseline"
  "si_sponsored_context_accountability"
)
REQUIRED_CLEAN_THREE_ZERO_SALES=(
  "media_buy_seller"
)
REQUIRED_CLEAN_THREE_ZERO_CREATIVE=(
  "creative_lifecycle"
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

storyboard_executed_exactly() {
  local storyboard_id="$1"
  local expected_passed="$2"
  local expected_skipped="$3"
  local log_file="$4"
  awk -v id="${storyboard_id}" -v passed="${expected_passed}" -v skipped="${expected_skipped}" '
    $0 ~ "^[[:space:]]+" id "([[:space:]]|$)" {
      pattern = "[[:space:]]✓[[:space:]]+" passed "P / " skipped "S"
      if ($0 ~ pattern) found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "${log_file}"
}

if [ "${MODE}" != "grade" ]; then
  # The plan for the queue: one log per tenant and how its storyboards run.
  # Current /sales and /creative-builder are isolated: each storyboard keeps its
  # own timeout, RSS, output and envelope checks, and runs in a worker process
  # with at most STORYBOARD_STORYBOARDS_PER_PROCESS-1 earlier storyboards of a
  # fixed batch (default 12; 1 gives each storyboard its own fresh process, as
  # CI does). Every other tenant runs in one process.
  TENANT_LOGS=()
  plan_args=()
  for entry in "${TENANTS[@]}"; do
    tenant="${entry%%:*}"
    log="${LOG_DIR}/${tenant}.log"
    TENANT_LOGS+=("${log}")
    tenant_mode=monolithic
    if { [ "${FLOOR_SET}" = "current" ] && [ "${tenant}" = "sales" ]; } \
      || [ "${tenant}" = "creative-builder" ]; then
      tenant_mode=isolated
    fi
    plan_args+=("${tenant}" "${tenant_mode}" "${log}")
  done
  PUBLIC_TEST_AGENT_TOKEN="${PUBLIC_TEST_AGENT_TOKEN:-storyboard-local-token}" \
    node "${REPO_ROOT}/scripts/run-storyboards-queue.mjs" --write-plan "${STATE_DIR}" "${LABEL}" \
      --timeout-ms "${STORYBOARD_TIMEOUT_MS:-180000}" \
      --storyboards-per-process "${STORYBOARD_STORYBOARDS_PER_PROCESS:-12}" \
      -- "${plan_args[@]}" || exit 1
  {
    printf 'FLOOR_SET=%q\n' "${FLOOR_SET}"
    printf 'LABEL=%q\n' "${LABEL}"
    printf 'LOG_DIR=%q\n' "${LOG_DIR}"
    printf 'TENANT_LOGS=('
    printf '%q ' "${TENANT_LOGS[@]}"
    printf ')\n'
  } > "${STATE_DIR}/state.sh"
fi
if [ "${MODE}" = "prepare" ]; then
  exit 0
fi
if [ "${MODE}" = "run" ]; then
  echo "Running ${#TENANTS[@]} tenant suites from one queue."
  node "${REPO_ROOT}/scripts/run-storyboards-queue.mjs" --state "${STATE_DIR}" &
  queue_pid=$!
  wait "${queue_pid}" || {
    echo "::error::The storyboard queue failed"
    exit 1
  }
  queue_pid=""
fi

tenant_index=0
for entry in "${TENANTS[@]}"; do
  tenant="${entry%%:*}"
  rest="${entry#*:}"
  min_clean="${rest%%:*}"
  min_passed="${rest##*:}"
  log="${TENANT_LOGS[${tenant_index}]}"
  # The queue records the exit status of each tenant's run; nonzero for an
  # isolated tenant means an infrastructure failure in its orchestration.
  orchestrator_failure=0
  if [ "$(cat "${STATE_DIR}/status-${tenant_index}" 2>/dev/null || echo 1)" != "0" ]; then
    orchestrator_failure=1
  fi
  tenant_index=$((tenant_index + 1))

  echo ""
  echo "──────────────────────────────────────────────"
  echo "Storyboards · /${tenant}  (floors: ${min_clean} clean, ${min_passed} steps)"
  echo "──────────────────────────────────────────────"

  clean=$(sed -nE 's/^[[:space:]]*storyboards: ([0-9]+)\/[0-9]+ clean$/\1/p' "${log}" | tail -1)
  passed=$(sed -nE 's/^[[:space:]]*steps: ([0-9]+) passed .*/\1/p' "${log}" | tail -1)
  selection=$(sed -nE 's/^[[:space:]]*selection: ([0-9]+) applicable \| ([0-9]+) not applicable \| ([0-9]+) quarantined \| ([0-9]+) corpus$/\1 \2 \3 \4/p' "${log}" | tail -1)

  if [ -z "${clean}" ] || [ -z "${passed}" ] || [ -z "${selection}" ]; then
    echo "::error::Failed to parse storyboard counts from runner output for /${tenant}."
    echo "  Log: ${log}"
    tail -40 "${log}"
    REGRESSED=1
    SUMMARY="${SUMMARY}\n  /${tenant}: ✗ parse failure (see ${log})"
    continue
  fi
  read -r applicable scope_not_applicable quarantined corpus <<< "${selection}"

  status="✓"
  failed_floor=""
  if [ "${orchestrator_failure}" -ne 0 ]; then
    status="✗"
    failed_floor="one or more isolated orchestrators failed"
  fi
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
    for requirement in "${REQUIRED_EXACT_CURRENT_SALES[@]}"; do
      storyboard_id="${requirement%%:*}"
      counts="${requirement#*:}"
      expected_passed="${counts%%:*}"
      expected_skipped="${counts##*:}"
      if storyboard_executed_exactly "${storyboard_id}" "${expected_passed}" "${expected_skipped}" "${log}"; then
        echo "  ✓ required-exact ${storyboard_id} (${expected_passed}P / ${expected_skipped}S)"
      else
        status="✗"
        failed_floor="${failed_floor:+${failed_floor}; }required-exact ${storyboard_id} did not pass ${expected_passed} steps with ${expected_skipped} skips"
      fi
    done
  fi

  required_exact=()
  if [ "${FLOOR_SET}" = "current" ]; then
    case "${tenant}" in
      governance) required_exact=("${REQUIRED_EXACT_CURRENT_GOVERNANCE[@]}") ;;
      signals) required_exact=("${REQUIRED_EXACT_CURRENT_SIGNALS[@]}") ;;
      brand) required_exact=("${REQUIRED_EXACT_CURRENT_BRAND[@]}") ;;
      creative-builder) required_exact=("${REQUIRED_EXACT_CURRENT_CREATIVE_BUILDER[@]}") ;;
    esac
  fi
  if [ "${#required_exact[@]}" -gt 0 ]; then
    for requirement in "${required_exact[@]}"; do
      storyboard_id="${requirement%%:*}"
      counts="${requirement#*:}"
      expected_passed="${counts%%:*}"
      expected_skipped="${counts##*:}"
      if storyboard_executed_exactly "${storyboard_id}" "${expected_passed}" "${expected_skipped}" "${log}"; then
        echo "  ✓ required-exact ${storyboard_id} (${expected_passed}P / ${expected_skipped}S)"
      else
        status="✗"
        failed_floor="${failed_floor:+${failed_floor}; }required-exact ${storyboard_id} did not pass ${expected_passed} steps with ${expected_skipped} skips"
      fi
    done
  fi

  if [ "${FLOOR_SET}" = "current" ] && [ "${tenant}" = "signals" ]; then
    for storyboard_id in "${REQUIRED_CLEAN_CURRENT_SIGNALS[@]}"; do
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

  if [ "${FLOOR_SET}" = "current" ] && [ "${tenant}" = "creative" ]; then
    for storyboard_id in "${REQUIRED_CLEAN_CURRENT_CREATIVE[@]}"; do
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

  if [ "${FLOOR_SET}" = "current" ] && [ "${tenant}" = "creative-builder" ]; then
    for storyboard_id in "${REQUIRED_CLEAN_CURRENT_CREATIVE_BUILDER[@]}"; do
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

  if [ "${FLOOR_SET}" = "current" ] && [ "${tenant}" = "si" ]; then
    for storyboard_id in "${REQUIRED_CLEAN_CURRENT_SI[@]}"; do
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

  if [ "${FLOOR_SET}" = "3.0-compat" ] && [ "${tenant}" = "sales" ]; then
    for storyboard_id in "${REQUIRED_CLEAN_THREE_ZERO_SALES[@]}"; do
      if storyboard_passed "${storyboard_id}" "${log}"; then
        echo "  ✓ required-clean ${storyboard_id}"
      else
        status="✗"
        failed_floor="${failed_floor:+${failed_floor}; }required-clean ${storyboard_id} did not pass"
      fi
    done
  fi

  if [ "${FLOOR_SET}" = "3.0-compat" ] && [ "${tenant}" = "creative" ]; then
    for storyboard_id in "${REQUIRED_CLEAN_THREE_ZERO_CREATIVE[@]}"; do
      if storyboard_passed "${storyboard_id}" "${log}"; then
        echo "  ✓ required-clean ${storyboard_id}"
      else
        status="✗"
        failed_floor="${failed_floor:+${failed_floor}; }required-clean ${storyboard_id} did not pass"
      fi
    done
  fi

  echo "  ${status} clean=${clean} passed=${passed} applicable=${applicable} n/a=${scope_not_applicable} quarantined=${quarantined}"

  if [ "${status}" = "✓" ]; then
    SUMMARY="${SUMMARY}\n  /${tenant}: ✓ ${clean} clean, ${passed} steps; ${applicable}/${corpus} applicable, ${scope_not_applicable} N/A, ${quarantined} quarantined"
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
echo "Tenant logs: ${LOG_DIR}"
echo ""

if [ "${REGRESSED}" -ne 0 ]; then
  echo "✗ One or more tenants regressed below floor — push blocked."
  echo "  Floors are mirrored from .github/workflows/training-agent-storyboards.yml."
  echo "  To bypass for a known-good lift (e.g. you intentionally raised a floor),"
  echo "  pass --no-verify or update the floors in both this script and the workflow."
  exit 1
fi

echo "✓ All tenants meet floors."
