---
---

Each agent in `/api/registry/publisher` now carries a property authorization
rollup: `properties_authorized` (count of this publisher's properties the
agent can sell) and `properties_total` (total properties the publisher
exposes). When property-level authorization rows exist, the count is the
intersection; when only publisher-wide authorization exists, the count
equals the total.

Lets a caller render "X of Y properties authorized for [agent URL]" without
re-walking the property graph.
