#!/bin/sh

set -eu

# Match Husky's behavior for source archives and other installs without Git
# metadata: dependency installation should still succeed, just without hooks.
if [ ! -e .git ] || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

# core.hooksPath is otherwise shared by every linked worktree. A per-worktree
# value prevents a stale checkout from redirecting another worktree's hooks.
# Point directly at the tracked hooks so a failed dependency install cannot
# leave hooks disabled because Husky's ignored shim directory was not generated.
git config extensions.worktreeConfig true
git config --worktree core.hooksPath .husky
