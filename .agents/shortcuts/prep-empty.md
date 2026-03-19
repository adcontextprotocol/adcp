# Prep Empty

Use this shortcut when the change is not a protocol/spec release change and
should carry an empty changeset.

## Workflow

1. Add an empty changeset.
2. If the change includes UI work, test it in a browser:
   - **Vibium** (preferred for quick checks): `vibium go <url>`, `vibium map`,
     `vibium click "Button text"`, `vibium type "field" "value"`, `vibium screenshot`
   - **Playwright** (for scripted flows): use the `/playwright-skill` skill
3. Run code review and address the suggestions.
4. Prepare the PR.

## Output Shape

Keep the response operational and concise. Call out anything still blocking the
PR.
