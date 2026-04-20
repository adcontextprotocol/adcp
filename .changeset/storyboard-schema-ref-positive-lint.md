---
---

Storyboard lint: positively require `schema_ref` on any step whose `task` is a known mutating tool. The existing idempotency-key check only runs on steps that declare a `schema_ref`, so a storyboard step calling a mutating tool without one would silently skip the check. This positive check catches the missing `schema_ref` itself as a lint error and identifies three pre-existing omissions in `deterministic-testing.yaml` (`sync_accounts_for_state`, `initiate_session`, `verify_terminated_session`), which are fixed in the same change.

Extracted from the red-team follow-up work in PR #2433 (finding I-9) as a standalone low-risk tooling fix.
