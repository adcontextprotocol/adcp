---
"adcontextprotocol": patch
---

fix(registry): per-agent `visibility` is the only listing gate (legacy `member_profiles.is_public` no longer hides public agents)

`member_profiles.is_public` is the **member-directory** flag (per migration 011: `-- Show in member directory`) and predates per-agent `visibility`. Continuing to gate the agent registry on it silently hid agents whose owners explicitly marked them `public` whenever the parent profile wasn't listed in the member directory — breaking the AAO member-profile UI's "Visibility: Public — Listed publicly and added to brand.json" promise.

Drops the profile-level `is_public` filter in:

- `FederatedIndexService.listAllAgents` / `listAllPublishers` / `lookupDomain` / `getStats` (back the public registry surface)
- `AgentService.listAgents` / `getAgentByUrl` (and the redundant "public agent on private profile → hide" early-continue)
- `CrawlerService.populateFederatedIndex` (publisher crawl)

Per-agent `visibility` (`public` / `members_only` / `private`) and per-publisher `is_public` are now authoritative. Profile-level `is_public` continues to gate the `/Members` directory listing only — its documented purpose.
