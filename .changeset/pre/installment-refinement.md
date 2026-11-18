---
"adcontextprotocol": minor
---

Choose specific installments through `refine_proposals` (experimental, `media_buy.installment_refinement`, adcp#8967).

A buyer sends `installment_changes`, a list of `{ product_id, installment_ref, action }` entries unique by `(product_id, installment_ref)`. `installment_ref` is the closed `core/canonical-installment-ref.json`, and `action` is `include` or `omit`. The seller answers with a draft that buys, for each named product, one product whose `installments[]` is exactly the selected set. That's the named product's installments with every `omit` removed and every `include` added, often in a product the seller derives for the selection. Entries a seller can't satisfy come back in `unsatisfied_installment_changes` on the result row, each with a `reason`, on a `partial` or `unable` result with `reason_code: "constraint_unsatisfiable"`.

Nothing in `commercial_terms` changes. Buying a product still buys its complete installment set, so `terms_digest` binds the choice through the `product_id`. Three rules make that hold:
- A seller MUST NOT change the installments of a product it has offered; a different set is a different `product_id`.
- The buyer compares each selected set with the returned product's `installments[]` and rejects a mismatch.
- The seller checks product membership before it resolves any installment reference.

A seller that supports it lists `media_buy.installment_refinement` in `experimental_features` and `installment_changes` in `media_buy.proposal_refinement.supported_dimensions`, and the capabilities schema requires the first whenever the second is present. Buyers send `installment_changes` only to such a seller. This is a new feature id. `media_buy.installment_selection`, which named the signed `purchases[].installments[]` withdrawn after beta.1, stays withdrawn, and 4.0 keeps that design (`installment_selection_required_in_4_0`).

New schemas: `core/installment-change.json` and `core/installment-change-set.json`. Every new field is `x-status: experimental` and `x-added-in: 3.3.0`. The training agent doesn't implement it yet.
