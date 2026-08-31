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

Stage the surface into three conformance tiers over one data model: `reporting.core` (obligations, revisions, five health states, `get_reporting_status` over existing transports — the only required tier, implementable by a polling-only seller with no destination, materialization, manifest, canonicalization, or receipt code), `managed_delivery` (file/dataset-share/warehouse offerings with materializations plus retention and revocation bounds), and `reconciled_billing` (`sync_reporting_receipts` plus the canonical-digest contract). Push is optional in every tier: `reporting.status_changed` is available to Core, while the materialization-specific `reporting.delivery_ready` doorbell is managed-delivery-only. Webhook signing is required only when a reporting notification is declared.

Complete the tier boundary one layer down: obligation destination and materialization fields, receipt counts, configuration destination readiness, and the healthy/complete conditions are now conditional on their tiers — Core healthy/complete is defined around an authoritative readable revision over existing API transports. `reporting.delivery_ready` is managed-delivery-only, and a new tier-independent `reporting.status_changed` invalidation announces health transitions in either direction (including clock-driven waiting-to-delayed and delayed-to-action_required) with stable `issue_id`s for durable work-item projection. Ships with the reporting.core implementation guide.
