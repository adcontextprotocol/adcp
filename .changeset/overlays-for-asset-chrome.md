---
"adcontextprotocol": minor
---

Add `overlays` to format asset definitions for publisher-controlled elements that render over buyer content.

Publishers can now declare video player controls, publisher logos, and similar per-asset chrome as `overlays` on individual assets. Each overlay includes `bounds` (pixel or fractional, relative to the asset's own top-left corner) and optional `visual` URLs for light and dark theme variants. Creative agents use this to avoid placing critical buyer content behind publisher chrome when composing creatives.
