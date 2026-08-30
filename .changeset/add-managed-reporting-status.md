---
"adcontextprotocol": minor
---

Add the experimental managed reporting delivery surface: caller-owned account
configuration with protocol-managed destination provisioning, `get_reporting_status`
summary/period/revision views, independently scheduled feed purposes, consistent
ledger reconciliation, durable delivery capabilities, immutable
obligation/revision/materialization records, a normative file manifest, authenticated
consumer reconciliation through `sync_reporting_receipts`, and the
`reporting.delivery_ready` notification. Advertise snapshot/official schedules as
atomic offerings, bind their applicability to products, and preserve explicit
full/partial/none/unknown package coverage through configuration, revisions, and
status aggregation. Publish portable, byte-exact reconciliation scenarios for SDKs,
machine-identify required canonicalization vectors, and enforce control-value and
physical-checksum discriminants in the source schemas.

Stage the surface into three conformance tiers over one data model: `reporting.core` (obligations, revisions, materializations, five health states, `get_reporting_status` over existing transports — the only required tier, implementable by a polling-only seller with no destination, manifest, canonicalization, or receipt code), `managed_delivery` (file/dataset-share/warehouse offerings with retention and revocation bounds), and `reconciled_billing` (`sync_reporting_receipts` plus the canonical-digest contract). The `reporting.delivery_ready` doorbell is optional in every tier, and webhook signing is required only when it is declared.
