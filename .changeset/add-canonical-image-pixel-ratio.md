---
"adcontextprotocol": minor
---

Add pixel-density and rendition-set support for 3.2 canonical images. Canonical image declarations now separate logical render dimensions from accepted intrinsic `pixel_ratios`; image assets may declare `pixel_ratio`; and image slots may use `required_pixel_ratios` to require coverage such as 1x plus 2x while leaving 1.5x optional. Top-level and slot density sets combine by intersection for both singular assets and rendition arrays. SDK inference, ambiguity, intersection, rendition coverage, and v2-narrows-v1 comparison are pinned by shared positive and negative vectors. The unversioned legacy reference catalog gains distinct 2x-only and paired 1x-plus-2x compatibility IDs that become discoverable across 3.x when deployed; their density and coverage annotations are forward-projection metadata for 3.2-aware SDKs, not pre-3.2 canonical semantics. New integrations use the 3.2 parameterized `display_image` template with `format_id.pixel_ratio`.
