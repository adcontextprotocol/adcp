---
"adcontextprotocol": patch
---

Patch 3.0 compatibility bundles so the frozen `schema_validation` past-start
branch-set steps use explicit `contributes_to: past_start_handled` flags instead
of the newer `contributes: true` shorthand. This avoids older runner paths
missing a passing branch contribution before the final `assert_contribution`
check, without ignoring real synthetic assertion failures.
