---
---

build(images): raise image size cap to 700KB and sign 4 walkthrough panels

The pre-commit image quality hook (`scripts/check-image-quality.sh`) capped raster images at 500KB. C2PA manifest signing adds ~100KB per file, pushing several already-committed walkthrough panels over the cap on any modification. This blocked the stage-3 backfill (#2370) from signing them and left them as the only unsigned AI-generated docs imagery in the repo.

Raise the cap to 700KB (covers the largest observed signed panel at 612KB with headroom) and sign the 4 size-only files in this PR via `scripts/backfill-c2pa-static.ts`:

- `brand-panel-01-campaign-brief.png` (466→594KB)
- `brand-panel-02-brand-discovery.png` (484→604KB)
- `brand-panel-03-rights-search.png` (421→515KB)
- `brand-panel-05-approval-paths.png` (445→612KB)

The 4 glyph files (`brand-before-after`, `brand-panel-06-creative-generation`, `diagram-04-delivery-aggregation`, `diagram-generative-tiers`) are out of scope — their original prompts were never committed, so regeneration is tracked separately in #4560.

Closes part of #2487.
