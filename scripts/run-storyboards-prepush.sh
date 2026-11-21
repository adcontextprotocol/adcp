#!/usr/bin/env bash
# Pre-push storyboard phase (.husky/pre-push): the current-source matrix and
# the 3.0 compatibility matrix, graded exactly as
# scripts/run-storyboards-matrix.sh and scripts/run-storyboards-3-0-compat.sh
# grade them, with every training-agent process of both surfaces run from one
# queue (scripts/run-storyboards-queue.mjs), at most ADCP_STORYBOARD_JOBS at a
# time (1 runs them one after another).
#
# The current surface builds dist/schemas/latest, which every training agent
# reads, so no training agent starts before that build finishes. Output: the
# current surface as it is graded, then the 3.0 compatibility surface.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.." || exit 1

exec node scripts/run-storyboards-queue.mjs --surface current --surface 3.0-compat
