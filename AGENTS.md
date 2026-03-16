# Agent Guide

This file is a thin wrapper. The canonical shared behavior for this repository
lives in [`.agents/playbook.md`](.agents/playbook.md).

## Start Here

1. Read [`.agents/playbook.md`](.agents/playbook.md).
2. Subagent role definitions: `.agents/roles/*.md`.
3. Prompt shortcuts: `.agents/shortcuts/`.
4. Codex multi-agent wiring is generated from `.agents/roles/` —
   run `node scripts/import-claude-agents.mjs` to regenerate `.codex/`.
5. Treat this file as a pointer only. Shared behavior changes belong in
   `.agents/playbook.md`.
