---
"adcontextprotocol": patch
---

Automate schema version synchronization with package.json

Implemented three-layer protection to ensure schema registry version stays in sync with package.json:

1. **Auto-staging**: update-schema-versions.js now automatically stages changes to git
2. **Verification gate**: New verify-version-sync.js script prevents releases when versions don't match
3. **Pre-push validation**: Git hook checks version sync before any push

Also fixed v2.1.0 schema registry version (was incorrectly showing 2.0.0) and removed duplicate creative-manifest entry.
