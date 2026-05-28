#!/usr/bin/env bash
# Run the training-agent storyboard matrix against the latest released 3.0.x
# compliance bundle checked into dist/compliance/. This catches regressions
# where main's training agent still passes current storyboards but no longer
# passes the frozen 3.0.x certification surface.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/run-storyboards-matrix.sh" --latest-3.0
