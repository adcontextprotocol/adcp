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
Completion is forbidden until every review thread is resolved after its fix or
specific evidence-backed disposition; enumeration alone is insufficient.
Required approval must apply to the current immutable head; the author cannot
self-satisfy an independent, human, or CODEOWNER approval, and bots/Sol never
replace designated human/CODEOWNER approval for gated paths.
