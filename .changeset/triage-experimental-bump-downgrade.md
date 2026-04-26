---
---

Triage routine now applies the experimental-surface bump downgrade per docs/reference/experimental-status.mdx: changes scoped to surfaces marked `x-status: experimental` (or under known-experimental paths like `static/schemas/source/tmp/**`, `sponsored-intelligence/**`, `a2ui/**`) ship one bump level lower — minor → patch, major → minor, patch stays patch. Mixed stable+experimental diffs take the stable bump.
