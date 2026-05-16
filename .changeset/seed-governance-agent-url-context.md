---
---

Seed `governance_agent_url` default in governance storyboards via storyboard-root `context:` block so `storyboard run` no longer SKIPs the `sync_governance` step when no explicit context is provided. Fixes #3913.
