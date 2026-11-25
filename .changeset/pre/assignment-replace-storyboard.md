---
"adcontextprotocol": minor
---

New storyboard `media_buy_seller/assignment_replace_transfers_settings`, gated on `creative.supports_assignment_trackers` and `creative.supports_assignment_landing_page`. It assigns a creative with an assignment tracker and a landing-page override through `sync_creatives` `assignment_operations`, replaces it with a second creative, and checks that `get_media_buys` and `list_creatives` show the tracker and landing page on the replacement.
