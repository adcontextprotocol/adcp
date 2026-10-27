---
"adcontextprotocol": minor
---

Add installments to the canonical Product used by the compact proposal lifecycle.

**Stable.** `core/canonical-product.json` gains `installments[]` of the new `core/canonical-installment.json`, closing the compact-lifecycle gap recorded in known limitations. The canonical installment is identified by the `(collection_ref, installment_id)` tuple alone: `collection_ref` is required, the deprecated publisher-domain-free `collection_id` shorthand is not inherited, a derivative names its source with `derivative_of.installment_ref`, and the shape is closed. `installments` requires `collections`, and joins the `list_products` `fields` projection — absence is run-of-collection only inside a projection that requested the field. Legacy `get_products` keeps `core/installment.json` unchanged, including its deprecated shorthand, because removing a declared property there would be a major change.

Naming the exact slots a purchase buys, and dropping or swapping one through `refine_proposals`, is not part of 3.3 and is planned for 4.0, because `commercial_terms` stays closed within 3.x (adcp#8501). A purchase buys the product as offered.
