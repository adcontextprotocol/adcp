#!/usr/bin/env bash
# Fetches just enough history for `origin/<base-branch>...HEAD` to resolve in a
# shallow CI checkout exactly as it would with full history, then reports how
# much it fetched.
#
# A full-history checkout (fetch-depth: 0) downloads every branch and tag and
# has consumed whole job budgets before any check ran (#8559). Path checks
# only need the merge base, so this fetches commits and trees (no blobs) for
# the base branch and HEAD with a doubling depth until an exact merge base
# appears, then falls back to their complete history. With still no merge
# base it fails: a diff without one must never pass as "no changes".
#
# Usage: scripts/fetch-merge-base.sh <base-branch>
set -euo pipefail

readonly REMOTE=origin
readonly INITIAL_DEPTH="${FETCH_MERGE_BASE_INITIAL_DEPTH:-50}"
readonly MAX_DEPTH="${FETCH_MERGE_BASE_MAX_DEPTH:-3200}"
# actions/checkout retries its own fetches; these fetches replace part of its
# work, so a transient network error should not fail the check either.
readonly FETCH_ATTEMPTS=3
readonly RETRY_DELAY_SECONDS="${FETCH_MERGE_BASE_RETRY_DELAY_SECONDS:-5}"
readonly POSITIVE_INTEGER='^[1-9][0-9]*$'
readonly NON_NEGATIVE_INTEGER='^[0-9]+$'
readonly MERGE_BASE_NOT_FOUND=1

fail() {
  echo "::error::$1"
  exit "${2:-1}"
}

base_branch="${1:-}"
if [[ -z "$base_branch" ]] || ! git check-ref-format --branch "$base_branch" >/dev/null 2>&1; then
  fail "Usage: fetch-merge-base.sh <base-branch>; got \"${base_branch}\"." 2
fi
if ! [[ "$INITIAL_DEPTH" =~ $POSITIVE_INTEGER && "$MAX_DEPTH" =~ $POSITIVE_INTEGER ]]; then
  fail "Fetch depths must be positive integers (initial ${INITIAL_DEPTH}, max ${MAX_DEPTH})." 2
fi
if ! [[ "$RETRY_DELAY_SECONDS" =~ $NON_NEGATIVE_INTEGER ]]; then
  fail "The retry delay must be a whole number of seconds (got ${RETRY_DELAY_SECONDS})." 2
fi

readonly base_ref="refs/remotes/${REMOTE}/${base_branch}"
head_sha=$(git rev-parse --verify 'HEAD^{commit}')
readonly head_sha
shallow_file=$(git rev-parse --git-path shallow)
readonly shallow_file
readonly started_seconds=$SECONDS

is_shallow() {
  [[ "$(git rev-parse --is-shallow-repository)" == true ]]
}

fetch_with_retry() {
  local attempt
  for (( attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1 )); do
    git fetch --no-tags --no-recurse-submodules --filter=blob:none "$@" && return 0
    if (( attempt < FETCH_ATTEMPTS )); then
      echo "::warning::git fetch failed (attempt ${attempt} of ${FETCH_ATTEMPTS}); retrying in ${RETRY_DELAY_SECONDS}s."
      sleep "$RETRY_DELAY_SECONDS"
    fi
  done
  fail "git fetch from ${REMOTE} failed after ${FETCH_ATTEMPTS} attempts."
}

fetch_targets=("+refs/heads/${base_branch}:${base_ref}" "$head_sha")
fetch_history() {
  fetch_with_retry "$@" "$REMOTE" "${fetch_targets[@]}"
  # Later fetches name the pinned base tip by SHA. Git skips an up-to-date
  # ref whenever another commit is also wanted, so a refspec would leave the
  # base side at its first depth while only HEAD deepened.
  fetch_targets=("$(git rev-parse --verify "${base_ref}^{commit}")" "$head_sha")
}

# A shallow graph can offer an older common ancestor (say, a release-branch
# commit merged into both sides) while the real merge base is still cut off.
# The answer is exact only when no shallow boundary lies between it and
# either tip, because then both sides are complete down to it.
merge_base_is_exact() {
  local commits
  [[ -s "$shallow_file" ]] || return 0
  # An unreadable range must fail, not pass as "no shallow commit above it".
  commits=$(git rev-list "$base_ref" "$head_sha" --not "$1") ||
    fail "Could not list the commits above merge base ${1}."
  ! grep -qxF -f "$shallow_file" <<<"$commits"
}

report_merge_base() {
  local merge_base status=0
  merge_base=$(git merge-base "$base_ref" "$head_sha") || status=$?
  if (( status == MERGE_BASE_NOT_FOUND )); then
    return 1
  elif (( status != 0 )); then
    fail "git merge-base failed (exit ${status}) for ${base_ref} and HEAD."
  fi
  merge_base_is_exact "$merge_base" || return 1
  echo "merge_base=${merge_base} base=${base_ref} head=${head_sha} history=$1 elapsed_seconds=$((SECONDS - started_seconds))"
  git count-objects -v
}

depth=$INITIAL_DEPTH
while is_shallow && (( depth <= MAX_DEPTH )); do
  fetch_history --depth="$depth"
  report_merge_base "depth-${depth}" && exit 0
  depth=$((depth * 2))
done

if is_shallow; then
  echo "::warning::No exact merge base within ${MAX_DEPTH} commits of ${base_ref} and HEAD; fetching their complete history."
  fetch_history --unshallow
else
  fetch_history
fi
report_merge_base complete && exit 0
fail "No merge base between ${base_ref} and HEAD, even with their complete history."
