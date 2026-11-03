---
"adcontextprotocol": minor
---

Assignment trackers: tracker-slot limits apply only when the effective format declares at least one tracker slot (a `pixel_tracker` slot or a canonical `impression_tracker`, `click_tracker`, or `viewability_tracker` slot). A format that declares none, such as canonical `image`, makes no slot-limit claim, so a seller does not reject an assignment tracker for lack of a slot; it still fires every accepted tracker or rejects the assignment. Trackers match slots by event (`impression_tracker` takes `impression`, `click_tracker` takes `click`, `viewability_tracker` takes the `viewable_*` events and `audible_video_complete`, any other `pixel_tracker` slot takes any event), and the same rules govern trackers a `replace` transfers (#8713).
