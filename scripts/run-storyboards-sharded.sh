#!/usr/bin/env bash
# Run the storyboard suite in sequential fresh Node processes, then emit one
# aggregate totals block compatible with the existing CI and local graders.
# Individual shard totals are deliberately relabeled: if a later shard is
# interrupted, graders must not mistake an earlier shard for a complete run.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

SHARD_COUNT=4
RUNNER_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --shard-count)
      if [ -z "${2:-}" ]; then
        echo "::error::--shard-count requires an integer argument" >&2
        exit 2
      fi
      SHARD_COUNT="$2"
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

TEMP_DIR=$(mktemp -d -t "adcp-storyboard-shards.XXXXXX")
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

run_shard() {
  local index="$1"
  if [ -n "${STORYBOARD_RUNNER_BIN:-}" ]; then
    "${STORYBOARD_RUNNER_BIN}" "${RUNNER_ARGS[@]}" --shard-index "${index}" --shard-count "${SHARD_COUNT}"
  else
    npx tsx server/tests/manual/run-storyboards.ts "${RUNNER_ARGS[@]}" --shard-index "${index}" --shard-count "${SHARD_COUNT}"
  fi
}

clean_sum=0
total_sum=0
passed_sum=0
failed_sum=0
skipped_sum=0
not_applicable_sum=0

for ((index = 0; index < SHARD_COUNT; index += 1)); do
  shard_number=$((index + 1))
  shard_log="${TEMP_DIR}/shard-${index}.log"

  echo ""
  echo "=== Storyboard shard ${shard_number}/${SHARD_COUNT} ==="
  # Stream progress so hosted runners never see a long silent process. tee
  # retains the raw totals for aggregation while the line-buffered transform
  # ensures only the final aggregate matches the graders' patterns.
  run_shard "${index}" 2>&1 \
    | tee "${shard_log}" \
    | perl -pe 'BEGIN { $| = 1 } s/^(\s*)--- Totals ---/$1--- Shard result ---/; s/^(\s*)storyboards: ([0-9]+\/[0-9]+ clean)$/$1shard result: $2/; s/^(\s*)steps: (.*)$/$1shard step result: $2/'
  runner_status=${PIPESTATUS[0]}

  storyboard_totals=$(sed -nE 's/^[[:space:]]*storyboards: ([0-9]+)\/([0-9]+) clean$/\1 \2/p' "${shard_log}" | tail -1)
  step_totals=$(sed -nE 's/^[[:space:]]*steps: ([0-9]+) passed \| ([0-9]+) failed \| ([0-9]+) skipped \| ([0-9]+) not applicable$/\1 \2 \3 \4/p' "${shard_log}" | tail -1)

  if [ -z "${storyboard_totals}" ] || [ -z "${step_totals}" ]; then
    echo "::error::Storyboard shard ${shard_number}/${SHARD_COUNT} exited ${runner_status} without a complete totals block" >&2
    exit 1
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
