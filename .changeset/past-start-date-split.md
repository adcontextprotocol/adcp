---
---

spec(compliance): split past_start_date into reject + adjust paths (#2376)

The `past_start_date` step in `universal/schema-validation.yaml` previously
conflated two observable outcomes ("reject with INVALID_REQUEST" OR
"accept with adjusted dates") into one step with no `expect_error`,
no `any_of`, and no mechanical way for the runner to validate either
branch. Its only validation was `context.correlation_id` echo — so an
agent that silently accepted a past start_time without adjusting would
have passed.

Replaced with the `auth_mechanism_verified` pattern already used in
`universal/security.yaml`:

- `past_start_reject_path` (optional phase): agents that reject past
  starts exercise this. `expect_error: true`, no `idempotency_key` (the
  request is expected to fail validation before mutation). Validates
  `error_code: INVALID_REQUEST`. Contributes `past_start_handled`.
- `past_start_adjust_path` (optional phase): agents that accept-and-
  adjust exercise this. `idempotency_key` present (real mutation).
  Validates `media_buy_id` in the success envelope. Contributes
  `past_start_handled`.
- `past_start_enforcement` (non-optional): `task: assert_contribution`
  with `check: any_of` over `past_start_handled`. Fails if neither path
  succeeded — an agent that silently accepts a past start_time without
  either behavior is now caught.

Conformant agents pass exactly one path and fail the other — that's the
whole point of the split. Either `any_of` success satisfies the
enforcement phase.
