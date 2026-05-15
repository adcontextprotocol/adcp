---
---

compliance(idempotency): runtime rate-limit replay invariant

Per L1/security.mdx#idempotency rule 3 ("Only successful responses are cached") and bullet 8 (insert-rate ceiling), a `RATE_LIMITED` response on idempotency-cache insert MUST NOT be cached as the canonical replay for that key. Otherwise `retry_after` is meaningless — a buyer retrying past the hint receives the cached error forever, regardless of when the limiter actually cleared.

Adds runtime grading for that invariant. Burst-volume attestation of the 60/300 req/sec threshold remains seller self-attestation (structurally non-deterministic in CI; see #2615 close).

Changes:

- New test-kit contract `rate_limit_trip_runner` at `static/compliance/source/test-kits/rate-limit-trip-runner.yaml`. Defines sequential fresh-key burst (50 ≤ max_attempts ≤ 500), trip-detection (first `RATE_LIMITED` response), wait + replay mechanics (sleep `retry_after`, replay captured key), and the not_applicable fallback when no `RATE_LIMITED` appears within the burst window.
- New task `expect_rate_limit_not_replayed` documented in `storyboard-schema.yaml` with full field spec and error modes.
- New cross-response check kind `replay_not_cached_rate_limit` registered in `runner-output-contract.yaml`. Compares `trip_response.error.code` vs `replay_response.error.code`; fails iff both are `RATE_LIMITED`.
- New phase `rate_limit_replay_invariant` at the end of `universal/idempotency.yaml`. Single step exercising the contract against `create_media_buy` with `max_attempts: 200` and `replay_max_wait_seconds: 30`.
- Updates the cache-growth-defense narrative in the storyboard preamble — bullet 8's MUST is now partially runtime-graded (the invariant), threshold remains self-attestation.

Coverage extends to #3305's new mutating ops (`build_creative`, `validate_input`) when they land: the phase's `trip_target_task` can be wired to any mutating op the agent declares, but `create_media_buy` is the canonical target in 3.0 and the only one this phase exercises today.

Closes #4547.
