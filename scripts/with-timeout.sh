#!/usr/bin/env bash
# Portable timeout wrapper. Prefers coreutils `timeout`/`gtimeout`; falls back
# to a bash background/trap/kill pattern when neither is installed.
#
# Usage: scripts/with-timeout.sh <seconds> <cmd> [args...]
#
# On expiry, SIGTERM is sent first with a 5s grace window before SIGKILL —
# letting the child attempt a clean shutdown.
#
# Not using `set -e` because the fallback branch handles exit codes explicitly;
# `-e` would abort before the explicit `exit "$code"` on a non-zero child.
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

if command -v timeout >/dev/null 2>&1; then
  exec timeout --preserve-status --kill-after=5 "$secs" "$@"
elif command -v gtimeout >/dev/null 2>&1; then
  exec gtimeout --preserve-status --kill-after=5 "$secs" "$@"
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
exit "$code"
