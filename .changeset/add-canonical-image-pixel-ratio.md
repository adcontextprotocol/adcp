---
"adcontextprotocol": minor
---

Add pixel-density and rendition-set support for 3.2 canonical images. Canonical image declarations now separate logical render dimensions from accepted intrinsic `pixel_ratios`; image assets may declare `pixel_ratio`; and image slots may use `required_pixel_ratios` to require coverage such as 1x plus 2x while leaving 1.5x optional. SDK inference, ambiguity, and rendition coverage are pinned by shared positive and negative vectors. The 3.1 reference catalog gains distinct legacy 2x-only and paired 1x-plus-2x compatibility formats; their density and coverage annotations are forward-projection metadata for 3.2-aware SDKs, not canonical 3.1 semantics. New integrations use the 3.2 parameterized `display_image` template with `format_id.pixel_ratio`.
