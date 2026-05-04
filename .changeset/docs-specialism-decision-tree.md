---
---

docs(compliance): add sales-specialism decision tree and deprecate sales-proposal-mode in docs (closes #4038)

Adopters had no consolidated guide for choosing the right `sales-*` specialism — the only option was to read every specialism's narrative block and triangulate. A wrong claim wastes the adopter's first compliance run by grading them against storyboards their architecture doesn't support.

Changes:

- **`compliance-catalog.mdx`** — adds `## Choosing a sales specialism` section (using `<Steps>`) between the media-buy specialism table and `## How to claim`. The tree resolves adopters to `sales-broadcast-tv`, `sales-catalog-driven`, `sales-social`, `sales-guaranteed`, or `sales-non-guaranteed` in three steps, covers the multi-specialism case (hybrid guaranteed + auction platforms), and explains the `media_buy.supports_proposals` capability flag with JSON examples. Also fixes the `sales-proposal-mode` status row from `stable` to `deprecated`.

- **`build-an-agent.mdx`** — removes `sales-proposal-mode` from the typical-specialisms table for `build-seller-agent` and rewrites the "Picking a sales specialism" section to link to the new decision tree and surface the `supports_proposals` flag.

- **`get-test-ready.mdx`** — updates the example `get_adcp_capabilities` response: replaces `sales-proposal-mode` with `sales-guaranteed` + `media_buy.supports_proposals: true`, and fixes `"media-buy"` → `"media_buy"` in `supported_protocols` (wire form is snake_case).
