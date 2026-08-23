#!/usr/bin/env bash
# Run isolated storyboard orchestrators with bounded parallelism and emit one
# aggregate totals block for local matrix grading.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

SHARD_COUNT=8
MAX_PARALLEL=4
RUNNER_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --shard-count)
      if [ -z "${2:-}" ]; then
        echo "::error::--shard-count requires an integer argument" >&2
        exit 2
      fi
      SHARD_COUNT="${2:-}"
      shift 2
      ;;
    --max-parallel)
      if [ -z "${2:-}" ]; then
        echo "::error::--max-parallel requires an integer argument" >&2
        exit 2
      fi
      MAX_PARALLEL="${2:-}"
      shift 2
      ;;
    --shard-index)
      echo "::error::--shard-index is managed by this script" >&2
      exit 2
      ;;
    *)
      RUNNER_ARGS+=("$1")
      shift
      ;;
  esac
done

if ! [[ "${SHARD_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::--shard-count must be a positive integer" >&2
  exit 2
fi
if ! [[ "${MAX_PARALLEL}" =~ ^[1-9][0-9]*$ ]] || [ "${MAX_PARALLEL}" -gt "${SHARD_COUNT}" ]; then
  echo "::error::--max-parallel must be a positive integer no greater than --shard-count" >&2
  exit 2
fi

TEMP_DIR=$(mktemp -d -t "adcp-isolated-storyboard-shards.XXXXXX")
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

run_shard() {
  local index="$1"
  if [ -n "${STORYBOARD_ISOLATED_RUNNER_BIN:-}" ]; then
    "${STORYBOARD_ISOLATED_RUNNER_BIN}" "${RUNNER_ARGS[@]}" --shard-index "${index}" --shard-count "${SHARD_COUNT}"
  else
    node scripts/run-storyboards-isolated.mjs "${RUNNER_ARGS[@]}" --shard-index "${index}" --shard-count "${SHARD_COUNT}"
  fi
}

pids=()
indexes=()
statuses=()

wait_for_batch() {
  local offset pid index status
  for ((offset = 0; offset < ${#pids[@]}; offset += 1)); do
    pid="${pids[$offset]}"
    index="${indexes[$offset]}"
    wait "${pid}"
    status=$?
    statuses[$index]="${status}"
  done
  pids=()
  indexes=()
}

for ((index = 0; index < SHARD_COUNT; index += 1)); do
  run_shard "${index}" > "${TEMP_DIR}/shard-${index}.log" 2>&1 &
  pids+=("$!")
  indexes+=("${index}")
  if [ "${#pids[@]}" -eq "${MAX_PARALLEL}" ]; then
    wait_for_batch
  fi
done
if [ "${#pids[@]}" -gt 0 ]; then
  wait_for_batch
fi

clean_sum=0
total_sum=0
passed_sum=0
failed_sum=0
skipped_sum=0
not_applicable_sum=0
infrastructure_failure=0

for ((index = 0; index < SHARD_COUNT; index += 1)); do
  shard_number=$((index + 1))
  shard_log="${TEMP_DIR}/shard-${index}.log"
  echo ""
  echo "=== Isolated storyboard shard ${shard_number}/${SHARD_COUNT} ==="
  perl -pe 's/^(\s*)--- Totals ---/$1--- Shard result ---/; s/^(\s*)storyboards: ([0-9]+\/[0-9]+ clean)$/$1shard result: $2/; s/^(\s*)steps: (.*)$/$1shard step result: $2/' "${shard_log}"

  storyboard_totals=$(sed -nE 's/^[[:space:]]*storyboards: ([0-9]+)\/([0-9]+) clean$/\1 \2/p' "${shard_log}")
  step_totals=$(sed -nE 's/^[[:space:]]*steps: ([0-9]+) passed \| ([0-9]+) failed \| ([0-9]+) skipped \| ([0-9]+) not applicable$/\1 \2 \3 \4/p' "${shard_log}")
  storyboard_totals_count=$(printf '%s\n' "${storyboard_totals}" | awk 'NF { count += 1 } END { print count + 0 }')
  step_totals_count=$(printf '%s\n' "${step_totals}" | awk 'NF { count += 1 } END { print count + 0 }')

  if [ "${storyboard_totals_count}" -ne 1 ] || [ "${step_totals_count}" -ne 1 ]; then
    echo "::error::Isolated shard ${shard_number}/${SHARD_COUNT} emitted ${storyboard_totals_count} storyboard totals and ${step_totals_count} step totals; expected exactly one of each" >&2
    exit 1
  fi
  if [ "${statuses[$index]}" -ne 0 ]; then
    echo "::error::Isolated shard ${shard_number}/${SHARD_COUNT} exited ${statuses[$index]}" >&2
    infrastructure_failure=1
  fi

  read -r shard_clean shard_total <<< "${storyboard_totals}"
  read -r shard_passed shard_failed shard_skipped shard_not_applicable <<< "${step_totals}"
  clean_sum=$((clean_sum + shard_clean))
  total_sum=$((total_sum + shard_total))
  passed_sum=$((passed_sum + shard_passed))
  failed_sum=$((failed_sum + shard_failed))
  skipped_sum=$((skipped_sum + shard_skipped))
  not_applicable_sum=$((not_applicable_sum + shard_not_applicable))
done

echo ""
echo "--- Totals ---"
echo "  storyboards: ${clean_sum}/${total_sum} clean"
echo "  steps: ${passed_sum} passed | ${failed_sum} failed | ${skipped_sum} skipped | ${not_applicable_sum} not applicable"
exit "${infrastructure_failure}"
