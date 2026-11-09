---
"adcontextprotocol": minor
---

Open the schemas that were meant to be open (working-group decision of 2026-11-09, DR-0036). Closing a schema only breaks validators that hard-code it, so opening one is not a protocol break.

`additionalProperties` goes from `false` to `true` at 778 of the 859 closed locations in the 3.3 source. Nothing else in those schemas changes, and every payload that was valid stays valid. This includes the capability blocks and containers that #8772 opened (daypart windows, the targeting overlay requirement and support containers, and the spot and canonical reporting capabilities), folded in here with thanks to Konstantin Mirin. The `sync_creatives` `assign` operation opens too. Its `operation` const keeps the branches apart, so it doesn't need #8772's named exception. From #8772, boolean `demographics` on the overlay schemas is also deprecated as the 3.2 shorthand for `{ "age": true }`. Senders MUST send the object form, receivers MUST accept `true`, and only support with `gender: true` satisfies a `gender` requirement. 4.0 removes the boolean form.

82 locations stay closed, each for a structural reason:

- `oneOf` forms told apart by key presence: `a2ui/bound-value.json` and the `brand.json` document forms.
- The signed commercial terms: `commercial-terms`, `product-purchase`, `change-term`, `change-term-constraints`, `sla-window`, `bidding-policy`, and the canonical measurement terms, performance standard, reporting commitment, pricing option and budget allocation.
- Join keys: metric `qualifier` objects and forecast dimensions.
- `canonical-installment-ref` and the JWS response-payload envelope.
- Privacy clamps: the TMP identity and context match requests, `catalog-item-reference-not-found-error`, the per-agent `PERMISSION_DENIED` and `BILLING_NOT_PERMITTED_FOR_AGENT` details, the failed and unconfigured `get_principal` results, and the `get_reporting_status` `lookup_unavailable` failure. That failure was opened during the 3.3 betas and is closed again with the envelope fields 3.2.8 declares, so unknown and unauthorized identifiers return one identical shape.
- Maps keyed by identifiers (`patternProperties`).

The additive-minor check now flags an added property only where the schema stays closed. It still fails on removals, renames, retypes, removed enum values, tightened bounds, new required names, and closing an open schema. The closed-anywhere-in-the-major rule and the reopening corrections are gone, and the baseline keeps 4 entries, each with its resolution.

**Generated types change.** A generator that reads `additionalProperties` now treats the opened objects as open: json-schema-to-typescript gives them an index signature, and Pydantic models stop forbidding extra fields. A strict validator built from the 3.2 schemas still rejects 3.3 fields on these objects, so send a 3.3 field only to a 3.3 peer. 3.2.10 opens the same locations that 3.2 has.
