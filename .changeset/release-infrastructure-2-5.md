---
"adcontextprotocol": patch
---

Add release infrastructure for 2.5.0: minor version symlinks and pre-written release notes.

This is preparation work for the 2.5.0 release. The actual version bump and schema changes will happen when the Version Packages PR is merged. This changeset is marked as patch since it only updates documentation and build tooling without changing the protocol itself.

**Changes:**
- Add minor version symlink support (v2.5 → 2.5.0) in build-schemas.js
- Add semver validation to prevent malformed version errors
- Pre-write comprehensive 2.5.0 release notes with migration guide
- Update homepage version references from 2.3.0 to 2.5.0
