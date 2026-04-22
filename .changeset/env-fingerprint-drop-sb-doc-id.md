---
---

compliance(storyboards): drop `sb=<doc.id>` from the contradiction lint's env fingerprint (#2670 part 2).

Including the storyboard id in the fingerprint was the conservative shape during the lint's initial rollout in #2661, but it suppressed the exact class of bug the lint was built to catch — cross-storyboard contradictions (#2627, #2628, #2629 all shared the shape "two locally-valid storyboards encoding disagreeing required responses for the same request").

Prerequisites now in place: #2679 added `test_kit` and top-level `fixtures` precision; #2684 audited principal identity and added `role=<doc.caller.role>` as the forward guard; #2708 tracks the remaining structural gap in `auth=`.

Experiment result on the current suite: removing `sb=` surfaces 10 multi-member groups (7 spanning ≥2 storyboard files) — all agreeing, zero new contradictions. The two largest cross-file groups are a cross-brand consistency win the lint could not previously reach: `get_adcp_capabilities → success` agreed by 25 files on `acme-outdoor.yaml` and by 6 files on `nova-motors.yaml`. Sync-accounts and get-products groups land smaller but the same way. The lint now exercises cross-storyboard consistency as originally intended.

Inverts one test (`no contradiction when storyboard IDs differ (independent test suites)` → `cross-storyboard contradictions surface when ids differ but env matches`) to pin the new behavior instead of the old false-negative, and adds a complementary negative test (`different test_kit + different ids → no contradiction`) that pins `test_kit=` as a cross-file separator now that `sb=` is gone.

Protocol review surfaced a residual hole that `sb=` removal exposes: when a step inherits the transport's default auth instead of overriding it, `fingerprintEnv` emits no `auth=` component at all, so two storyboards with different transport defaults collide. Out of scope for this change and tracked separately in #2711.
