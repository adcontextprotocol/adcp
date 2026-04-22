---
---

compliance(storyboards): add `role=<doc.caller.role>` to the contradiction lint's env fingerprint as a forward-compatible discriminator for the "shared `test_kit`, distinct principal roles" case flagged in #2684.

Audit of the current 56-storyboard suite (#2684): every storyboard declares `caller.role: buyer_agent`, and no storyboard declares `prerequisites.principal`. The two shared `test_kit` paths (`acme-outdoor.yaml` ×42 and `nova-motors.yaml` ×6) are consumed uniformly by `buyer_agent` callers. So `test_kit` is a sufficient principal-identity proxy today and the fingerprint collision shape the issue describes does not exist.

Including `role=` anyway is cheap (no-op on the current suite — every event gets the same `role=buyer_agent` component) and load-bearing the moment #2670 part 2 drops `sb=<doc.id>` from the fingerprint. At that point the first storyboard that pairs a non-`buyer_agent` caller with an already-shared test_kit would false-positive as a contradiction; `role=` keeps the two legitimately distinct test vectors separate without requiring the author to remember the convention.

Documents the proxy reasoning and the forward guard in the `fingerprintEnv` comment, and adds two tests — one covering the shared-kit/distinct-role discrimination, one pinning the `role=` behavior with a direct `fingerprintEnv` comparison and covering the missing-caller / non-string-role guards.

Protocol review surfaced a deeper structural gap that the `role=` addition does not cover: the `auth=` component today hashes `<type>:<value_strategy>`, not the resolved principal identity. Two kits with the same auth shape but different `auth.api_key` values collide on `auth=`, which becomes relevant once a single test kit exposes multiple principals and step-level auth overrides select among them. Out of scope for this change; tracked in #2708.
