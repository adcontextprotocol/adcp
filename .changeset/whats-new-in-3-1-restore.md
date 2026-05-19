---
"adcontextprotocol": patch
---

Re-apply `docs/reference/whats-new-in-3-1.mdx` cleanly from current main after the original landing (PR #4784) was reverted to restore accidentally-deleted `dist/docs/` versioned snapshots. Content is identical to the original page — comprehensive 3.0 → 3.1 narrative covering 15 headline features synthesized from a full audit of every spec PR merged since 3.0.6.

Adds two nav entries in `docs.json` under the existing **AdCP 3.0** groups.

Closes the gap reopened by the revert.
