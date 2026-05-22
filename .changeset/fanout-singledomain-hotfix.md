---
---

fix(crawler): also fan publisher_properties[].publisher_domains[] from crawlSingleDomain + crawlSingleDomainForCatalog

#4840 wired the fan-out helper into the two periodic-crawl loops (L457 registered publishers, L542 sales-agent claimed publishers) but missed the on-demand `crawlSingleDomain` path (called by `POST /api/registry/crawl-request`) and `crawlSingleDomainForCatalog` (called by the manager revalidation queue worker). Both iterate `authorized_agents[]` independently and need the same fan-out call.

Symptom: admin-triggered crawl of cafemedia.com refreshed the manifest cache (`last_verified_at` updated) but didn't synthesize the 6,800 child rows — the directory inverse-lookup kept returning a single `cafemedia.com` row with `properties_total: 0`.

Fix: add `await this.fanOutPublisherPropertiesAuthorizations(authorizedAgent, domain)` inside both per-agent loops (`crawlSingleDomain` at line ~1346 and `crawlSingleDomainForCatalog` at line ~1620), mirroring the periodic-crawl paths.
