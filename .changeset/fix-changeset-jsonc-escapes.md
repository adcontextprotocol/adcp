---
---

chore(changesets): unescape backticks in `per-version-badges-stage5-brand-json.md`

The Stage 5 changeset (PR #3604) was committed with `\`\`\`jsonc` (literal
backslash-backticks) for its code fence. Mintlify's MDX pipeline runs
acorn over `.changeset/*.md` files and emits a noisy `Could not parse
expression with acorn` warning on every CI run. Replacing the escaped
fence with a plain ` ```jsonc ` block clears the warning. No content
change.
