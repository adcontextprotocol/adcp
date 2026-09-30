---
"adcontextprotocol": patch
---

compliance: fix the storyboard-level capability gate in `media_buy_seller/refine_frequency_cap_negotiation`. It declared `requires_capability: { all: [...] }`, which is not a valid gate shape (`requires_capability` is a single predicate with `path`), so runners crashed before executing any step. The predicates now use `requires_all_capabilities`, and the refinement predicate requires `supported_dimensions` to contain `criteria` and `product_changes` (the dimensions the storyboard exercises) instead of mere presence, since an empty list authoritatively means ask-only refinement.
