---
"adcontextprotocol": minor
---

Add a SHOULD that sellers return `request_proposals` `proposals[]`, and the `refine_proposals` per-result `proposals[]`, best-first by the seller's own assessment of fit, with `products[]` in order of first reference. `list_products` has no brief and so no relevance basis: its `products[]` SHOULD keep a stable order across the pages of one cursor walk and position carries no ranking. Order is a seller-relative preference: buyers MUST NOT treat position as a delivery, pricing, or quality commitment, and positions are not comparable across sellers. Prose only: no new fields, and sellers returning arbitrary order stay conformant. A buyer-declared ranking objective and a relevance score are deferred. Refs #5673.
