# Claude Guide

This file is a thin wrapper. The canonical shared behavior for this repository
lives in `.agents/playbook.md`.

## Start Here

1. Read `.agents/playbook.md`.
2. Subagent role definitions: `.agents/roles/*.md`.
3. Prompt shortcuts: `.agents/shortcuts/`.
4. Treat this file as a pointer only. Shared behavior changes belong in
   `.agents/playbook.md`.

## Mandatory: Changesets on Every PR

Every PR **must** include a changeset. Before pushing, always run:

```bash
npx changeset --empty
```

Then add a description to the generated `.changeset/*.md` file. Use `--empty` (no package entry) for non-protocol changes (server, UI, docs, infra, tools). Only use `patch`/`minor`/`major` for changes to the published AdCP protocol spec (schemas, task definitions, API reference). See `.agents/playbook.md` for details.
