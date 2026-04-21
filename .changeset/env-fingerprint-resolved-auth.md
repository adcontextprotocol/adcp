---
---

compliance(storyboards): resolved-auth fingerprint shape (#2708 + #2711).

Replaces the inline auth-emission in `fingerprintEnv` with a `describeStepAuth` helper that always returns a stable token — closing two structural gaps the sb= removal (#2670 part 2) exposed:

**#2711** — `if (step.auth)` meant inheriting steps emitted nothing, so 336 of the 340 steps in the current suite contributed no `auth=` component and could collide with explicit steps authored against divergent transport defaults. Fixed by emitting `auth=kit_default` for absent `step.auth`, keeping inheritance as a distinct, legible fingerprint position.

**#2708** — `auth.from_test_kit` was read as a boolean regardless of whether it was `true` or a string path, and `auth.value` literals were fingerprinted as `literal` with no identity hash. Both collapsed distinct principals into one group. Fixed by:
- `from_test_kit: "<path>"` → `auth=<type>:from_test_kit:<path>` (forward-compatible with multi-principal kits; today no kit exposes multiple principals so this is latent shape work)
- `value: "<literal>"` → `auth=<type>:literal:<sha1(literal, 8)>` (literal keys are a code smell but the hash guards against silent discrimination loss)

No kit in the current suite declares multiple principals; no storyboard uses string-form `from_test_kit` or literal `value` — zero grouping change on the current 56-storyboard suite, confirmed by running the full contradiction lint before and after.

Adds three tests: a shape-matrix unit test for `describeStepAuth` covering every branch (absent, none, `from_test_kit: true`, `from_test_kit: "<path>"`, `value_strategy`, literal, defensive fallbacks); an inherited-default cross-storyboard test pinning the `auth=kit_default` emission; and a multi-principal forward-guard test pinning that named-principal selection discriminates correctly.
