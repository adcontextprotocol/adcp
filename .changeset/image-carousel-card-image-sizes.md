---
"adcontextprotocol": minor
---

`image_carousel` gains an optional `card_image_sizes` parameter (adcp#8911): a list of accepted logical `{ width, height }` pairs for card images, the same shape as `native_in_feed`'s `main_image_sizes`. Each image card's `media` must match one listed pair exactly; a larger image at the same ratio does not match. When the `cards` slot declares `pixel_ratios`, the intrinsic size is the matched pair times the selected ratio. All card images in one creative match pairs of the same aspect ratio. The field does not constrain video card media. When `card_aspect_ratio` is also declared, every listed pair must have that ratio within 1%; a declaration where they disagree is invalid. Additive and optional: existing declarations are unchanged, and a seller that omits the field leaves card pixel size unconstrained beyond `card_aspect_ratio`.
