---
"adcontextprotocol": patch
---

Make media-buy compliance scenarios respect auction-only sellers and declared optional capabilities. Price-independent lifecycle, reporting, discovery, and format fixtures use non-guaranteed CPM floors, with bids supplied for auction buys. Product filtering tests no longer require sellers to seed guaranteed inventory.

Discover native reporting and canonical compatibility support before seeding optional feature fixtures; unsupported native shapes produce visible coverage gaps, while malformed discovery and failed advertised operations remain failures. Canonical compatibility checks no longer require vendor metrics and match product/format contracts independently of catalog order.

Currency filtering follows the account's effective transaction currency and checks every returned media price without assuming fixture IDs, rate-card IDs, ordering, or exact counts. Correct invalid native/audio channel fixtures to display/streaming_audio.
