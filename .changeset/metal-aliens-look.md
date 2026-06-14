---
---

refactor(certification): generalize the protocol-triggered recertification engine beyond S2 into a config-driven delta registry (`server/src/config/recertification-deltas.ts`). Behavior-preserving — the S2 canonical-formats delta is unchanged (frozen 13-case test stays green); other modules can now register recert deltas via config instead of hard-coded constants. Server-internal; no package release.
