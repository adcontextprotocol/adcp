---
---

Fix flaky addie-router LLM test for opinion-poll channel messages (#3101).

Clarifies the channel-ignore prompt to explicitly call out opinion polls (e.g. "what do you all think about IAB CTV guidelines?") with a carve-out preserving responses to AdCP-specific protocol questions. Replaces the non-deterministic live-API assertion with a recorded fixture so the test is stable on every PR.
