---
---

fix(crawler): skip publisher_properties fan-out when crawl source is a delegating child

#4851 wired fan-out into all four crawl call sites, but missed that the crawl SOURCE isn't always the manifest's host. When a crawl hits a publisher that delegates via `ads.txt MANAGERDOMAIN=`, the crawler fetches the file from the manager domain — but the source publisher being processed is the delegating child, not the manager. Firing fan-out from those calls used the **child** as the `manager_domain` attribution for all 6,800 siblings, overwriting whichever sibling got crawled most recently.

**Observed in production:** after the cafemedia crawl, `07.gg.manager_domain = '2foodtrippers.com'` instead of `'cafemedia.com'` — because a 2foodtrippers.com crawl had fired fan-out after the cafemedia crawl and stamped itself as the manager.

**Prospective fix** (crawler.ts): at all four fan-out call sites, gate on `validation.discovery_method !== 'ads_txt_managerdomain'`. Delegating-child crawls skip fan-out; the manager's own crawl handles it.

**Retrospective fix** (migration 487): walk the chain `child.manager_domain → grandparent → root` and reset every `adagents_authoritative` row whose `manager_domain` points to another `adagents_authoritative` row, pointing it at the first non-`adagents_authoritative` ancestor (the actual manager — typically `cafemedia.com` for the Raptive set, `discovery_method='direct'`). Bounded recursion (depth 10) defends against unexpected cycles.
