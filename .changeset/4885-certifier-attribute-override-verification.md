---
---

fix(certification): repair script reads Certifier `attributes['recipient.name']` (the actual render layer), not the stale `recipient.name` snapshot

Closes #4885. Earlier diagnosis was wrong — the repair script's PATCH `/credentials/{id}` does succeed; Certifier writes the new name into the credential's `attributes` override map, and the certificate design template renders from that override (verified on Credsverse: Tom Hespos, Tom Charles, Tsvetelina Georgieva, Davide Astuto all show the correct name today). The `recipient.name` field on the credential GET is a denormalized snapshot that stays stale — it does NOT drive rendering.

The actual bug: the script's `needsRepair()` compared against `recipient.name`, so the dry-run kept reporting already-fixed credentials as still-broken. This produced the false "silent-success" signal that originally went into #4885.

Fix:
- `server/src/services/certifier-client.ts` — declare `attributes?: Record<string, string>` on `CertifierCredential`; document the snapshot-vs-override semantics on both the `recipient` and `attributes` fields and on `updateCredential`.
- `server/src/scripts/repair-credential-recipient-names.ts` — introduce `effectiveRenderedName(remote)` that reads `attributes['recipient.name']` first and falls back to `recipient.name`. Use it in both the dry-run scan and the post-apply verification step. The apply loop now re-GETs after every PATCH and fails loudly if the rendered name didn't actually change — so the "PATCH 200 but field didn't mutate" class of bug can't reach silent-success again.

Server-only; no spec change.
