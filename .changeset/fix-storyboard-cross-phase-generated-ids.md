---
"adcontextprotocol": patch
---

compliance: carry cross-phase generated IDs through `context_outputs` generators instead of `$generate:uuid_v4#alias` tokens. The storyboard runner scopes `$generate` aliases to a single phase, so a later phase that reused an alias minted a different UUID. In `media_buy_seller/governance_conditions`, `governance_spend_authority`, and the `governance_approved` scenarios for brand rights, creative transformers, and signal marketplace, the governed mutation's `idempotency_key` differed from the one in the `check_governance` payload that authorized it, so the executed request no longer matched the authorized payload. `media_buy_seller/account_change_feed` gets the same fix (as in #7716). A new build-time lint (`scripts/lint-storyboard-generate-phase-scope.cjs`) fails when a `$generate` alias appears in more than one phase of a storyboard.
