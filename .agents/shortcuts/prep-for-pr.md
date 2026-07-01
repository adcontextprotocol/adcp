# Prep For PR

Use this shortcut when the user wants help getting a change ready for a pull
request.

## Workflow

1. Run the change through all relevant subagents and thoughtfully address the
   feedback.
2. If there are UI changes outside documentation, test them in a browser:
   - **Vibium** (preferred for quick checks): `vibium go <url>`, `vibium map`,
     `vibium click "Button text"`, `vibium type "field" "value"`, `vibium screenshot`
   - **Playwright** (for scripted flows): use the `/playwright-skill` skill
3. If API or MCP logic changed, run the server locally and verify the behavior
   directly.
4. Classify whether the PR needs a changeset:
   - Protocol/spec/release-surface changes need an `adcontextprotocol`
     changeset with the correct semver bump.
   - App, site, billing, admin, Addie, newsletter, digest, infra, migration,
     and operational-only changes should have **no** changeset. Remove stray
     `.changeset/*.md` files instead of adding empty ones.
   - If a changeset is present, stage it because the CLI ignores untracked
     files, then run:
     `git add .changeset/<name>.md && node scripts/check-changeset-protocol-scope.cjs origin/main && npx --yes @changesets/cli@^2.31.0 status --since=origin/main`.
   - If no changeset is expected, run:
     `node scripts/check-changeset-protocol-scope.cjs origin/main`.
5. Run code review and address the findings.
6. Run the `security-reviewer` agent and address all Must Fix and Should Fix
   findings before proceeding.
7. Draft the PR output:
   - short conventional-commits title; validate with
     `node scripts/check-pr-title.cjs "fix(scope): summary"`
   - summary
   - testing section
   - risks or follow-ups
8. Create the PR, resolve merge conflicts if needed, and make sure CI passes.
9. **Check CodeQL comments on the PR** — run `gh api repos/adcontextprotocol/adcp/pulls/{PR_NUMBER}/comments` and fix any CodeQL findings (unused imports, XSS, polynomial regex, etc.). These block merge.

## Output Shape

Keep the response compact and reviewer-oriented. Flag anything missing instead
of pretending the PR is ready.
