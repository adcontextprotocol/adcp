---
---

docs: point new specialism authors at the substitution-safety phase template (#2654 polish)

Closes the last acceptance item on #2654 — a short "Adding a catalog-
substitution-safety phase to a new specialism" section in
`docs/contributing/storyboard-authoring.md` that directs authors at the
`phase_template:` block already shipped in
`static/compliance/source/test-kits/substitution-observer-runner.yaml`,
rather than copy-pasting from a sibling specialism.

The template pattern, the `lint:substitution-vector-names` drift-guard,
and the NFC normalization rule all landed in PR #2656. This doc pointer
is the last polish item so authors reaching for a fourth consumer
(sales-retail-media, sales-broadcast-tv, etc.) find the template before
they clone.
