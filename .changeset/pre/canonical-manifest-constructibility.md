---
"adcontextprotocol": minor
---

Add a typed `video_brief` manifest asset carrying the existing structured VideoBrief, and align canonical slot declarations and reference fixtures with executable asset types. Carousel fixtures use the existing `card` asset.

Validate asset values under every supported slot name, including platform-specific IDs, on input and library readback instead of skipping structural validation for names outside the canonical vocabulary. Add reference manifest coverage so product fixtures cannot silently require unrepresentable assets. Preserve the existing object-or-array union audit entries at their renamed schema pointers.
