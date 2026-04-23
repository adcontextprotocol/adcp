#!/bin/bash
# Cloud environment setup for AdCP routines.
# Paste this into the "Setup script" field when creating the routine's
# environment at claude.ai/code/routines.
# Runs as root on Ubuntu 24.04 on first use; result is cached ~7 days.

set -euo pipefail

# gh CLI is not pre-installed. Add it for `gh issue list`, `gh pr create`, etc.
apt-get update
apt-get install -y gh

# Node toolchain is present (20/21/22 via nvm). Use the current default.
# Cache npm deps for the docs build so triage PRs that touch MDX can run
# schema validation without a slow npm install every session.
if [ -f package.json ]; then
  npm ci --prefer-offline --no-audit --no-fund || npm install --no-audit --no-fund
fi

# Python toolchain is present (with pip, uv, poetry). No project-level
# install needed for this repo — it's mostly docs and schemas.

echo "Setup complete."
