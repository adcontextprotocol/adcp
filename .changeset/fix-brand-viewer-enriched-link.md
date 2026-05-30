---
---

fix(registry): serve enriched-source brand.json under `/brands/:domain/brand.json` with provenance signaled via the new `X-AAO-Source` response header. Previously the gate 404'd enriched rows, breaking the "Community brand.json" link on the brand viewer for every Brandfetch-derived brand (e.g. sbs.com.au). The viewer now labels the link and the badge by actual source — "Community contributed" / "Community brand.json" for community rows, "Enriched" / "Enriched brand.json" for Brandfetch-derived rows — so the UI no longer claims community attestation for unedited enrichments.
