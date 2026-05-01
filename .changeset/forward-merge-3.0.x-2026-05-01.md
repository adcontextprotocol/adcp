---
---

Forward-merge `3.0.x → main` (manual replacement for the auto-`forward-merge-3.0.yml` workflow that was failing on conflicts since the v3.0.3 cut). Brings 3.0.x patches — including `provides_state_for` storyboard schema field, `peer_substituted` skip reason, sales-social `provides_state_for: sync_accounts` declaration, and tracker_pixel docs fix — into main per `.agents/playbook.md` § Release lines.

Empty changeset (no version bump): the underlying spec changes were already released as v3.0.3 with their own changesets; this merge just reconciles the lines.
