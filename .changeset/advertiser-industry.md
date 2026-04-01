---
"adcontextprotocol": minor
---

Add advertiser industry taxonomy. New `advertiser-industry` enum with two-level dot-notation categories (e.g., `media_entertainment.podcasts`, `technology.software`). The brand manifest `industries` field now references the enum, and `CreateMediaBuyRequest` gains an optional `advertiser_industry` field so agents can classify the advertiser when creating campaigns. Sellers map these to platform-native codes (Spotify ADV categories, LinkedIn industry IDs, IAB Content Taxonomy). Includes restricted categories (gambling_betting, cannabis, dating) that platforms require explicit declaration for.
