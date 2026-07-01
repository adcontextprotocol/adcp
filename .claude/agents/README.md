# .claude/agents/ is generated — do not edit

Files in this directory are **regenerated from `.agents/roles/`** by
`scripts/import-claude-agents.mjs`. Direct edits here will be clobbered
the next time the script runs (which the CI sync-check enforces on every
PR that touches `.agents/roles/` or `.claude/agents/`).

## To edit a role

1. Edit the corresponding file in `.agents/roles/{name}.md`.
2. Run `npm run sync:agents` (or `node scripts/import-claude-agents.mjs`).
3. Commit both the source change and the regenerated `.claude/agents/*.md`.

## Why is this directory tracked if it's generated?

Two reasons:

1. **Claude Code's agent loader reads `.claude/agents/*.md`** — without
   the committed copies, contributors checking out the repo wouldn't
   have working agents until they ran the sync script.
2. **The production Docker image copies `.claude/agents/`** at build time
   (see `Dockerfile`), and Addie's runtime expert-panel reference loads
   from this path at startup. Generating in CI instead of committing
   would require a build step we don't currently run.

See `.agents/playbook.md` Cross-Agent Integration section for the full
architecture.
