---
"adcontextprotocol": minor
---

spec(creative): merge a seller-created copy into the buyer's creative on a package. When a seller's operator or system attaches its own copy of a buyer's creative to a package, `list_creatives` shows two rows for one creative. `replace` swaps them but traffics the buyer's creative as a new serving object, with a new review and a delivery discontinuity. The new `merge` operation keeps the existing object instead.

- New `sync_creatives` `assignment_operations[]` variant `{ "operation": "merge", "creative_id", "package_id", "merged_creative_id" }`. `merged_creative_id` MUST be a seller-assigned creative (`creative_id_source: seller`) currently assigned to the package.
- The seller verifies every merge in the request. Assignment operations stay atomic: any rejection applies nothing and returns the new correctable code `CREATIVE_MERGE_REJECTED`, whose details (`error-details/creative-merge-rejected.json`) list each rejected merge with its `operation_index` and a `reason` from the new `creative-merge-rejection-reason` enum: `content_mismatch` (the seller judges it a different creative), `format_mismatch` (the buyer can fix by syncing a matching format), `not_on_package` (reported uniformly for unknown IDs), or `not_supported` (the seller cannot merge this pairing on this package). A seller that needs a person to confirm a match returns the `submitted` envelope, and the completion artifact carries the outcome; buyers SHOULD send such a `merge` in its own request.
- A successful response reports `merges[]`, one entry per applied merge with the inherited `approval_status` and `assignment_platform_id`, so buyers learn each outcome without a follow-up read.
- On success the buyer's assignment inherits the merged creative's approval, weight, placement routing, and per-package `assignment_platform_id`. Sellers MUST NOT re-review it unless the content differs. Delivery is reported under the buyer's `creative_id` from the merge; earlier delivery is not restated. The merged creative loses its assignment on the package but is not purged.
- New capability `creative.supports_assignment_merge` (requires `has_creative_library: true`). Sellers that do not declare it reject `merge` with `UNSUPPORTED_FEATURE`, and buyers MUST NOT send it.

All additions are optional, so 3.2 payloads remain valid.
