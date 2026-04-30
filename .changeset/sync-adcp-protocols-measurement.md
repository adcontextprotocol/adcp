---
---

chore(server): sync ADCP_PROTOCOLS const with adcp-protocol.json after `measurement` was added

Adding `measurement` to `enums/adcp-protocol.json` (capability-block PR) tripped
the `adcp-taxonomy` enum-sync test. Two related touch-ups so badge issuance
stays bounded by what has shipped:

- `ADCP_PROTOCOLS` adds `measurement` (matches the JSON enum).
- `BadgeRole` stays narrow — re-exported from `compliance-db.ts` rather than
  aliased to `AdcpProtocol`. Measurement has no specialism storyboards or
  migration entry yet, so it isn't a badge role.
- `VALID_BADGE_ROLES` in `badge-svg.ts` mirrors the narrow list explicitly,
  so the badge API doesn't accept a role the DB CHECK constraint will reject.
