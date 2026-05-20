---
---

fix(catalog): allow `adagents_authoritative` as an `evidence=` filter value on `/registry/authorizations` (#4841 follow-up)

#4879 added the `adagents_authoritative` evidence value to `catalog_agent_authorizations` and projected ~6,800 cafemedia children into catalog, but `authorization-snapshot-db.ts:parseEvidenceParam` rejected `?evidence=adagents_authoritative` with 400 because the validator's `VALID_EVIDENCE` set was hardcoded to the pre-#4841 enum.

Adds the new value to `VALID_EVIDENCE`. **Not** added to `DEFAULT_EVIDENCE` — the partner-sync default stays strict-bilateral `adagents_json` only; consumers opt in to weaker evidence explicitly.
