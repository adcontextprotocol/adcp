---
"adcontextprotocol": minor
---

Add experimental `collection_lists` and `collection_lists_exclude` to targeting (`media_buy.collection_lists`, #7834). A package can reference several independently managed collection lists: it runs on the intersection of every `collection_lists` entry and excludes the union of every `collection_lists_exclude` entry. The singular `collection_list` / `collection_list_exclude` types are unchanged, and a package MUST NOT set singular and plural for the same direction. Product `overlay_support` (and `required_overlay_support`) gain the matching keys, with `max_references` on the structured support form following `max_values_per_package`; a request over the limit is rejected, never truncated. Seller-level capability booleans are unchanged.
