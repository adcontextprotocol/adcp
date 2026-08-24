---
"adcontextprotocol": minor
---

Add `time_based_views` to delivery reporting: an array of time-threshold video view counts, each entry keyed by (threshold_seconds, basis). The new `view-threshold-basis` enum distinguishes play-time counting (platform 2s/6s video views) from in-view counting (IAB/MRC viewable video), which are materially different numbers at the same threshold and must not be conflated or summed. Capability-gated via the `time_based_views` token in available-metric. Implements RFC #6430 with the basis discriminator the RFC's open questions pointed toward.
