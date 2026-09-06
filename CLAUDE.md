# Claude Guide

This file is a thin wrapper. The canonical shared behavior for this repository
lives in `.agents/playbook.md`.

## Start Here

1. Read `.agents/playbook.md`.
2. Subagent role definitions: `.agents/roles/*.md`.
3. Prompt shortcuts: `.agents/shortcuts/`.
4. Treat this file as a pointer only. Shared behavior changes belong in
   `.agents/playbook.md`.

## PR Completion Gate

Follow the canonical **PR Preparation Checklist** in `.agents/playbook.md`.
No Claude session may declare a PR or task done, ready, mergeable, or complete,
or enable or expect merge, while any PR review thread remains unresolved.
Every bot and human thread—including outdated threads—must be verified,
substantively addressed when actionable, and explicitly resolved first. CI
passing and an approval do not waive this gate.
