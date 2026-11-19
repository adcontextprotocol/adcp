#!/bin/sh
# cpu-limit.sh SECONDS COMMAND [ARG...]
# Runs COMMAND with each of its processes, and every process it starts,
# limited to SECONDS of CPU time (RLIMIT_CPU); a process that uses them up is
# killed with SIGXCPU. Tests use it to bound spawned work by CPU, not wall time.
ulimit -t "$1" && shift && exec "$@"
