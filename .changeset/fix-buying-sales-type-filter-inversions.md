---
---

Flip six `agent.type === 'buying'` filter sites to `'sales'` — they semantically operate on sales agents (the ones that hold publisher authorizations and call `list_authorized_properties`), but the filter was set during the pre-#3496 era when sales tools were mis-classified as `'buying'`. Once #3495 corrected the classification, these filters silently matched zero real agents, breaking the publisher reverse-crawl path, health/property stats, the publisher tracker, the cache warmer, and registry response enrichment. Also adds `sales` to two `by_type` stats tallies that previously omitted it. Refs #3538, #3495.
