---
"adcontextprotocol": minor
---

Hoist 13 duplicate inline enum sets into shared `enums/` definitions (follow-up to #3148).

Adds `match-type`, `collection-kind`, `frame-rate-type`, `scan-type`, `gop-type`, `moov-atom-position`, `binary-verdict`, `account-scope`, `governance-decision`, `billing-party`, `feature-check-status`, `snapshot-unavailable-reason`, and `travel-time-unit` as standalone `$id`-bearing enum files. Updates 20 source schemas to `$ref` these files instead of repeating the inline definitions. Wire format is unchanged in all cases.
