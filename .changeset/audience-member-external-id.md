---
"adcontextprotocol": minor
---

Add `external_id` field to AudienceMember for buyer-assigned stable identifiers (CRM record ID, loyalty ID). Remove `external_id` from uid-type enum — it was not a universal ID and belongs as a dedicated field. Add `external_id` to `supported_identifier_types` in capabilities so sellers can advertise support.
