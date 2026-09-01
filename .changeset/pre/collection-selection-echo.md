---
"adcontextprotocol": minor
---

Add `targeting_overlay.collection_selection`, mirroring `placement_selection`: buyers name a complete committed collection set as domain-qualified selectors (partial selection gated by `collection_targeting_allowed`), and sellers MUST echo the committed selection on package readback — materializing concrete selectors even when the selection was produced through `collection_list` references — making the package readback collection-echo obligation satisfiable. Resolved collection-list rows can now carry the domain-qualified identity (`publisher_domain` + `collection_id`) so rows remain matchable without a platform-independent distribution identifier.
