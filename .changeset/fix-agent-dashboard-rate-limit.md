---
---

Fix: agent dashboard 429s on normal load. The `/registry/agents/:encodedUrl/compliance` and `/compliance/history` endpoints were gated by `bulkResolveRateLimiter` (20/min — designed for batch endpoints that resolve up to 100 domains per call). The dashboard fans out 2-3 per-agent reads, so a member with 10+ saved agents tripped the cap on a single page load. Split into a dedicated `agentReadRateLimiter` (240/min) sized for the dashboard burst while still bounding enumeration scripts.
