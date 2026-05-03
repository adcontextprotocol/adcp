---
---

Add static catalog aliases for `sales_guaranteed` and `sales_broadcast_tv` storyboard products on 3.0.x. The `@adcp/client@5.21.1` runner does not invoke `seed_product` via `controller_seeding: true`, so these product IDs must be present in the training agent's static catalog as a 3.0.x workaround. Fixes PRODUCT_NOT_FOUND failures for `sports_preroll_q2_guaranteed`, `outdoor_ctv_q2_guaranteed`, `primetime_30s_mf`, and `late_fringe_15s_mf`.
