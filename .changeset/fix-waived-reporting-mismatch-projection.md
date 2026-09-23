---
"adcontextprotocol": patch
---

Reconcile the experimental Reliable Reporting waiver lifecycle with its health and issue projections. An exact bilateral waiver now retires the caller-scoped `CONSUMER_STATUS_MISMATCH`, restores the underlying seller health in summary and period views, leaves the immutable consumer statement auditable, and uses the existing `reporting.status_changed` recovery transition when health changes. This repairs an unrepresentable state without changing the JSON Schema wire shape.
