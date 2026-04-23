#!/bin/bash
# Cloud environment setup for AdCP routines.
# Paste this into the "Setup script" field when creating the routine's
# environment at claude.ai/code/routines.
# Runs as root on Ubuntu 24.04 on first use; result is cached ~7 days.

set -euo pipefail

# Install gh CLI from GitHub's official apt repo (not in default Ubuntu repos).
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y gh

# Install deps. `--ignore-scripts` blocks preinstall/postinstall hooks from
# executing — important because the setup script runs as root and lifecycle
# scripts are a prompt-injection escalation path (attacker-crafted PR that
# modifies package.json could otherwise run on the next cache miss).
if [ -f package.json ]; then
  npm ci --prefer-offline --no-audit --no-fund --ignore-scripts
fi

echo "Setup complete."
