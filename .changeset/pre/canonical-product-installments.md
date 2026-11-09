---
"adcontextprotocol": minor
---

Add installments to the canonical Product used by the compact proposal lifecycle, and let a proposal buy named slots.

**Stable.** `core/canonical-product.json` gains `installments[]` of the new `core/canonical-installment.json`, closing the compact-lifecycle gap recorded in known limitations. The canonical installment is identified by the `(collection_ref, installment_id)` tuple alone: `collection_ref` is required, the deprecated publisher-domain-free `collection_id` shorthand is not inherited, a derivative names its source with `derivative_of.installment_ref`, and the shape is closed. `installments` requires `collections`, and joins the `list_products` `fields` projection — absence is run-of-collection only inside a projection that requested the field. Legacy `get_products` keeps `core/installment.json` unchanged, including its deprecated shorthand, because removing a declared property there would be a major change.

**Experimental** (`media_buy.installment_selection`). `media-buy/product-purchase.json` gains `installments[]`, so a proposal purchase names the exact slots it buys inside `commercial_terms` and therefore under `terms_digest`. Entries use the new closed `core/canonical-installment-ref.json` and are ordered by the JCS bytes of each reference, so equal bought sets always serialize to equal digests. `media-buy/proposal-refinement.json` gains `installment_changes` (`core/installment-change-set.json`) to drop or swap a slot on `revise`, forbidden on `finalize` and `extend_hold`; `refine-proposals-response.json` reports shortfalls through `unsatisfied_installment_changes`, which is also a witness for `constraint_unsatisfiable`. `installment_changes` joins `media_buy.proposal_refinement.supported_dimensions`, and declaring it requires `media_buy.installment_selection` in `experimental_features`.

`terms_digest` binds which slot identifiers were bought, not what the seller later publishes under them: installment references are deliberately not definition-pinned, and that bound is recorded in known limitations.
