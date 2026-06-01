---
---

Add durable backoff state for registry agents whose capability probes still infer `unknown`.

The crawler now retries unknown classifications on a 1/2/4/7-day cadence, stops after 10 attempts, and records whether the terminal state was an unreachable endpoint or a reachable-but-unclassifiable agent.
