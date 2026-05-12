---
---

fix(scripts): make `rehost-external-brand-logos` dry-run actually side-effect-free

Discovered while running the prod backfill that introduced this script: `rehostExternalLogo` was called unconditionally, which downloaded the bytes and inserted a `brand_logos` row even when `--apply` was absent. The script only gated the final manifest `UPDATE` on `--apply`, so dry-run produced orphan blob rows (harmless thanks to `(domain, sha256)` dedup on re-runs, but misleading — a dry-run is supposed to read state and write nothing).

Dry-run now lists the URLs it would attempt and exits without touching the database. The per-URL outcome (rewrite vs left-alone) is reported only in `--apply` mode, since it depends on live fetches. Output labels updated to make the distinction explicit ("Brands eligible / URLs to attempt" in dry-run vs "Brands touched / URLs rewritten / URLs left" in apply).
