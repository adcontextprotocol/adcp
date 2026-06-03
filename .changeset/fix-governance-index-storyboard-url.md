---
---

Fix unreachable governance fixture URL in protocol index storyboards. `protocols/media-buy/index.yaml` and `protocols/governance/index.yaml` had `https://governance.pinnacle-agency.example` hardcoded in their `sync_governance` sample_request, causing 4 Media Buy scenarios to always fail with DNS resolution errors. Adds root-level `context: governance_agent_url` block (matching the pattern from #3913) and switches the hardcoded URL to `$context.governance_agent_url`. The inventory-list targeting references to the same domain in `acme-outdoor.yaml` and `inventory_list_*.yaml` are a separate follow-up (they need a hosted property-list agent endpoint, not the same fix). Closes #5253.
