#!/usr/bin/env bash
# Portable timeout wrapper. Prefers coreutils `timeout`/`gtimeout`; falls back
# to a bash background/trap/kill pattern when neither is installed.
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

"$@" &
pid=$!

# `kill -0` guards against PID recycling: if the child has already exited,
# skip the kill so we don't target a reused pid.
(
  sleep "$secs"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    sleep 5
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null
    fi
  fi
) &
watcher=$!

cleanup() {
  if kill -0 "$watcher" 2>/dev/null; then
    kill "$watcher" 2>/dev/null || true
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait "$pid"
code=$?
trap - EXIT INT TERM
cleanup
report_if_timeout "$code" "$@"
exit "$code"
