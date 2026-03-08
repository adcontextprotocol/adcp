---
"adcontextprotocol": minor
---

Move list_creatives and sync_creatives from media-buy to creative protocol. All creative library operations now live in one protocol — any agent hosting a creative library implements the creative protocol for both reads and writes. Extend build_creative with library retrieval mode (creative_id, macro_values, media_buy_id, package_id). Add creative agent interaction models (supports_generation, supports_transformation, has_creative_library) to get_adcp_capabilities. New creative-variable.json schema for DCO variable definitions.
