---
---

Fix migration `477_broadcast_delivery_criteria.sql` which called `_append_criterion()` without redefining it. The helper was created and dropped inside migration 407, so any later migration that wants to use it must redefine it inline (same pattern 407 uses).

Migration 477 has been broken since it merged — failing every PR's integration-test job at `Apply migrations to test database` with `function _append_criterion(unknown, unknown, unknown, unknown) does not exist`, and blocking deploys. This patches it so the function is created at the top, the criteria are appended, and the function is dropped at the end — identical structure to 407. No criterion text or IDs are changed; only the function-availability wrapper is added.
