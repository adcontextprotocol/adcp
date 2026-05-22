---
---

docs(schema): replace `reference.adcp.org` placeholder with RFC 2606 `.example` domain

The `creative_agents[].agent_url` description strings in `list-creative-formats-response.json`
(both `creative/` and `media-buy/` variants) used `reference.adcp.org` as an example URL.
`adcp.org` is not the organization's domain (`adcontextprotocol.org` is), and `.adcp` reads
as a fictional or unknown TLD. Replaced with `reference.example.com` per RFC 2606 — now both
examples in the description string use the reserved `.example` TLD consistently.

Fixes #4652.
