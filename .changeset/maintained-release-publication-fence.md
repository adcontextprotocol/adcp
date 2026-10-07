---
'adcontextprotocol': patch
---

Restrict maintained 3.1 release publication to the approved committed version and original release merge. Require current-branch, final-head maintainer permission and provenance checks; stage and verify the exact four signed GitHub assets before publication; preserve immutable R2 bytes with conditional creation. Remove publisher re-signing, direct Changesets tagging and unfiltered historical uploads. Existing released artifacts and protocol semantics remain unchanged.
