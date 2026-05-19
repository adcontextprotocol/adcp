---
---

fix(certification): credential recipient name no longer becomes "undefined undefined"

When a learner earned a credential before WorkOS populated their first_name/last_name, naive `${first} ${last}` interpolation sent the literal string "undefined undefined" to Certifier (escalation #382, Tom Hespos). Introduce `buildRecipientName` that trims each field independently and falls back to email when both are missing. Use it from both issuance call sites (Addie's `issueCertifierBadge` and the admin backfill route). Also adds `updateCredential` wrapping Certifier `PATCH /credentials/{id}` and a dry-run audit + repair script at `server/src/scripts/repair-credential-recipient-names.ts`.
