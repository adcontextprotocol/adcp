---
---

Stage 4 of C2PA provenance signing (#2370): sign member portraits, and composite a small visible "AI" badge in the bottom-right corner of every generated avatar.

The badge satisfies CA SB 942's visible-disclosure requirement without dominating the portrait; it sits at ~10% of the short edge, rounded-rect dark background with white "AI" letters. The badge is composited *before* signing so the signature covers the disclosed pixels — any post-sign edit breaks the manifest.

Wires the same failure policy as stage 2: `C2PA_STRICT=true` rethrows, default returns the badged-but-unsigned buffer so a transient signing failure never blocks a member from getting their portrait. Every failure fires a throttled `notifySystemError` alert under source `c2pa-portrait-signing`. Schema columns added in migration 414 (stage 1); this PR threads them through `portrait-db.createPortrait` and the `/api/portraits/generate` route.
