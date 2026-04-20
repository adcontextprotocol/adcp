---
---

Stage 3 of C2PA provenance signing (#2370): sign docs storyboards at generation time and backfill the 113 existing PNGs under `images/**` and `docs/images/**`.

`scripts/generate-images.ts` — the build-time script behind every docs walkthrough panel — now embeds an AAO manifest into each freshly-generated PNG when the operator has the C2PA signing env vars set. The other generator scripts (`gen-top-illustrations.ts`, `regen-illustrations.ts`, `gen-perspective-covers.ts`, `gen-member-illustrations.ts`) already route through `generateIllustration()` so they pick up stage 2 signing for free.

`scripts/backfill-c2pa-static.ts` is a one-shot that walks the two image roots, detects real MIME type via magic bytes (some committed `.png` files are JPEGs), skips anything already carrying an embedded manifest, and signs the rest in place. Ran locally against AAO's production signing key — 113 PNGs signed, 5 already-signed from a prior experiment left untouched, 5 JPEG-as-PNG files correctly signed with the right MIME. Resulting diff is binary-heavy but mechanically simple.
