---
"adcontextprotocol": minor
---

Add pixel-density support for canonical and legacy image formats. Canonical image declarations now separate logical render dimensions from accepted intrinsic `pixel_ratios`; image assets may declare `pixel_ratio`, with SDK inference pinned by shared positive and negative vectors. The 3.1 reference catalog gains concrete 2x compatibility formats with lossless canonical projections, while new integrations use the 3.2 parameterized `display_image` template with `format_id.pixel_ratio`.
