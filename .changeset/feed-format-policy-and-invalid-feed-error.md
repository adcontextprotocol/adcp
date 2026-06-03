---
"adcontextprotocol": minor
---

docs(spec-guidelines): enum-membership criterion + reconcile sync_catalogs phantom error codes (#3456)

Records the **enum-membership criterion** as a durable spec-authoring guideline in `docs/spec-guidelines.md` (under Enum Design), generalizing the decision recorded on #3456: a value earns membership when it is **published**, **natively supported** (handled without bespoke per-value mapping), and has **shared demand** (relevant across >1 producer AND >1 consumer); a material dialect earns its own value only when the parent's consumer would mis-handle it. `feed_format` (#3456) is the worked example, with a note distinguishing this from platform-agnosticism (a `feed_format` value legitimately names a vendor's *published spec*).

Reconciles four error codes documented in the `sync_catalogs` error table but absent from `enums/error-code.json` — `FEED_FETCH_FAILED`, `INVALID_FEED_FORMAT`, `ITEM_VALIDATION_FAILED`, `CATALOG_LIMIT_EXCEEDED` — adding them to the canonical enum with `enumDescriptions` + `enumMetadata` (all `recovery: correctable`) and `held-for-next-minor` (3.1) drift dispositions. The `INVALID_FEED_FORMAT` phantom flagged on #5271 turned out to be one of four siblings in the same table.

Refs #3456 (resolution shipped in #5298; this is the durable docs formalization + the error-code reconciliation).
