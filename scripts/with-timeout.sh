#!/usr/bin/env bash
# Portable timeout wrapper. Prefers coreutils `timeout`/`gtimeout`; falls back
# to a bash background/trap/kill pattern when neither is installed. Both stop
# the command's whole process group, not only its direct child.
#
# Usage: scripts/with-timeout.sh <seconds> <cmd> [args...]
#
# On expiry, SIGTERM is sent first with a 5s grace window before SIGKILL —
# letting the child attempt a clean shutdown. A timeout prints an explicit
# marker to stderr: a silently SIGTERMed test suite is indistinguishable from
# a mystery failure, and the marker is what tells a reader "budget, not bug".
#
# Not using `set -e` because exit codes are handled explicitly; `-e` would
# abort before the explicit `exit "$code"` on a non-zero child.
set -u -o pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <seconds> <cmd> [args...]" >&2
  exit 2
fi

secs="$1"
shift

if ! [[ "$secs" =~ ^[0-9]+$ ]]; then
  echo "error: seconds must be a non-negative integer, got: $secs" >&2
  exit 2
fi

# Optional load-compensation scale (ADCP_TIMEOUT_SCALE). Budgets are
# calibrated for an otherwise-idle machine; on a host running many parallel
# agent workspaces the same suite can take several times longer, and a
# killed-at-budget run is indistinguishable from a hang. Setting e.g.
# ADCP_TIMEOUT_SCALE=3 scales every with-timeout budget without touching
# call sites, keeping the calibrated ratios between stages intact. The
# scale only stretches the kill deadline — it never weakens what runs.
# Invalid values are ignored with a warning rather than failing the hook.
if [ -n "${ADCP_TIMEOUT_SCALE:-}" ]; then
  if [[ "${ADCP_TIMEOUT_SCALE}" =~ ^[0-9]+([.][0-9]+)?$ ]] \
    && awk -v s="${ADCP_TIMEOUT_SCALE}" 'BEGIN { exit !(s >= 1) }'; then
    secs=$(awk -v t="$secs" -v s="${ADCP_TIMEOUT_SCALE}" 'BEGIN { printf "%d", (t * s) + 0.999999 }')
  else
    echo "with-timeout: ignoring invalid ADCP_TIMEOUT_SCALE='${ADCP_TIMEOUT_SCALE}' (need a number >= 1)" >&2
  fi
fi

started=$(date +%s)

report_if_timeout() {
  local code="$1"
  shift
  local elapsed=$(( $(date +%s) - started ))
  # 124 = coreutils timeout default; 143/137 = TERM/KILL with --preserve-status
  # or the bash fallback. Only report when the budget was actually consumed,
  # so a child that exits 143 on its own doesn't produce a false marker.
  if { [ "$code" -eq 124 ] || [ "$code" -eq 143 ] || [ "$code" -eq 137 ]; } \
    && [ "$elapsed" -ge "$secs" ]; then
    echo "⏰ TIMEOUT: with-timeout killed the command after ${secs}s (exit $code, elapsed ${elapsed}s): $*" >&2
  fi
}

if command -v timeout >/dev/null 2>&1; then
  timeout --preserve-status --kill-after=5 "$secs" "$@"
  code=$?
  report_if_timeout "$code" "$@"
  exit "$code"
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout --preserve-status --kill-after=5 "$secs" "$@"
  code=$?
  report_if_timeout "$code" "$@"
  exit "$code"
fi

# Fallback, as coreutils `timeout` does: run the command in its own process
# group and signal the whole group, not only the direct child. A vitest
# forks-pool worker whose main process is killed would otherwise run on,
# waiting for it forever. With job control on (`set -m`), each background
# job gets its own group: the command's, and the watcher's below, so killing
# the watcher also stops its `sleep`. The command's standard input stays
# /dev/null, as it is for a background job without job control. Job control
# goes off again once both have started, so bash reports their exits as it
# did before.
set -m
"$@" </dev/null &
pid=$!

group_alive() { kill -0 -- "-$1" 2>/dev/null; }

# SIGTERM the command's group, then SIGKILL whatever is left after the 5 s
# grace window. `group_alive` guards against reuse: once the group is gone,
# its id is not signalled again.
stop_group() {
  group_alive "$pid" || return 0
  kill -TERM -- "-$pid" 2>/dev/null
  local waited=0
  while group_alive "$pid" && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if group_alive "$pid"; then
    kill -KILL -- "-$pid" 2>/dev/null
  fi
}

(
  sleep "$secs"
  stop_group
) &
watcher=$!
set +m

# Also on a normal exit: processes the command left in its group (workers
# of a main process that crashed) must not outlive it.
cleanup() {
  kill -- "-$watcher" 2>/dev/null || true
  stop_group
}
trap cleanup EXIT INT TERM

wait "$pid"
code=$?
trap - EXIT INT TERM
cleanup
report_if_timeout "$code" "$@"
exit "$code"
