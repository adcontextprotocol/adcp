---
"adcontextprotocol": minor
---

spec(media-buy): clarify finalize-exclusivity and multi-finalize atomicity in `get_products` `refine[]`.

The 3.0.6 spec allows multiple `refine[]` entries and matches `refinement_applied[]` by position, but was silent on what a seller does when one entry has `action: 'finalize'` and others don't. Two adopting SDKs (`adcp-client`, `adcp-client-python`) settled on "process the first finalize; silently drop the rest" — undocumented, divergent across wrappers, and inconsistent with the existing `proposal_finalize` compliance scenario which keeps refine and finalize on separate steps. The conformance harness couldn't enforce a contract because the spec hadn't picked one.

Picked **option (a) — finalize is exclusive within `refine[]`** with explicit multi-finalize atomicity:

- If any entry has `action: 'finalize'`, **all** entries in the array MUST be proposal-scoped finalize entries. Mixing finalize with `include` / `omit` or with request- / product-scoped entries MUST be rejected with `INVALID_REQUEST`.
- Multi-finalize against different `proposal_id`s in one call is allowed and MUST be **atomic** — all proposals commit or none do; partial commits are non-conformant. Sellers that cannot guarantee atomic multi-proposal commit MUST reject multi-finalize arrays with `INVALID_REQUEST` and name the constraint in `error.message`.
- No capability flag for multi-finalize — the failure response is the discovery surface, so buyers MUST NOT assume support without a successful first attempt.

Why (a) over (b) "finalize-with-ordered-refinement" or (c) "implementation-defined":
- (a) matches the existing `proposal_finalize.yaml` compliance scenario, which already separates refine and finalize into distinct phases (`refine_proposal` has no finalize; `finalize_proposal` has only finalize).
- (b) introduces ordering + partial-failure semantics across mixed entries, expanding the seller state machine for no buyer-side win (the buyer who wants both can sequence the calls trivially).
- (c) leaves divergent SDK behavior in the field and is exactly the gap this issue asks to close.

Files:
- `static/schemas/source/media-buy/get-products-request.json` — `refine` field description gains the finalize-exclusivity and multi-finalize atomicity contract. `action.finalize` enum description cross-references the array-level rule.
- `docs/media-buy/product-discovery/refinement.mdx` — new `## Finalize is exclusive within refine[]` section before `## Proposals in refine mode` with ✅/❌ examples and the multi-finalize atomicity contract.

SDK alignment: `adcp-client`'s `detectFinalizeAction` and `adcp-client-python`'s `detect_finalize_action` should reject mixed arrays at the SDK layer rather than silently dropping non-finalize siblings; tracked separately in those repos.

Closes #4107.
