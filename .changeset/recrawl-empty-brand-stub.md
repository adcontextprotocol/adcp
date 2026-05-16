---
---

Auto-crawl on `/api/registry/publisher` now re-triggers when a stub
brand row exists without a manifest. Brian found wonderstruck.org
serving a valid brand.json at /.well-known/brand.json but the publisher
page reporting "no brand.json yet" — root cause was a previous crawl
having written a brand row with `has_brand_manifest=false` (the
discovery path stamps `brand_name=domain` even when the manifest fetch
fails). The `brandNeverCrawled` heuristic was reading "row exists" as
"already checked," refusing to retry.

Fix: `brandNeverCrawled` is now `!brandRow || !brandRow.has_brand_manifest`,
so empty stubs are eligible for re-crawl. Also: `files.brand_json.name`
is now suppressed when there's no real manifest — a domain-literal
placeholder is misleading.
