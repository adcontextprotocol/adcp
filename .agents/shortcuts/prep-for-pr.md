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
4. Check for the right changeset. If none exists, or the type is wrong, fix it.
5. Run code review and address the findings.
6. Run the `security-reviewer` agent and address all Must Fix and Should Fix
   findings before proceeding.
7. Draft the PR output:
   - short title
   - summary
   - testing section
   - risks or follow-ups
8. Create the PR, resolve merge conflicts if needed, and make sure CI passes.

## Output Shape

Keep the response compact and reviewer-oriented. Flag anything missing instead
of pretending the PR is ready.
