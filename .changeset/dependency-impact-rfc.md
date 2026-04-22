---
---

Draft RFC for 3.1 covering **Dependency Impact & Health Notifications** (epic: adcontextprotocol/adcp#2853): a unified mechanism for buyers to detect and respond to mid-flight dependency state changes on a live media buy — seller-initiated audience suspensions, creative disapprovals, event-source outages, property depublication, catalog withdrawals — without polling every resource individually.

Design in `specs/dependency-impact.md`. Scope spans per-resource offline lifecycle states, a new `media-buy-status: at_risk` value with `impacts[]` field, a new `notification_type: impact` webhook channel, and a new `impact.coherence` compliance assertion. Narrows adcontextprotocol/adcp#2838 (audience suspension) as the first child ticket.

No wire changes — spec doc only.
