---
---

Crawler now caches successful adagents.json fetches into the publishers
overlay table (migration 432) and projects parsed properties into
catalog_properties + catalog_identifiers in the same transaction. The
existing discovered_properties / agent_property_authorizations writes
continue alongside the new ones for one release as a fallback before PR 5
of #3177 drops the old tables.

Closes the gap surfaced by Setupad escalation #218: properties that landed
in discovered_properties via the crawler never made it into the catalog
because migration 336 was a one-time seed. Every successful crawl now
lands in both places.

Refs #3177. Builds on #3195.
