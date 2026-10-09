---
"adcontextprotocol": minor
---

spec(creative): add `start`, `first_quartile`, `midpoint`, `third_quartile` and `complete` to the `pixel_tracker` event enum so a buyer can attach playback trackers to `video_hosted` and `audio_hosted`. Each means the same as its VAST counterpart and is spelled in snake_case; `complete` means played to the end whether or not audio was on, and `audible_video_complete` stays the audio-on variant. The events are ignored on formats with no playback timeline, like `viewable_video_50`, and are valid in `tracker-execution-selector.json`. A v2→v1 downgrade drops them with `PIXEL_TRACKER_LOSSY_DOWNGRADE` rather than emitting them as `impression_tracker`. 3.2 buyers send them as `event: custom` with the 3.3 value as `custom_event_name` until they move to 3.3. Adds a non-normative Google Ad Manager / FreeWheel mapping.

Closes #8110.
