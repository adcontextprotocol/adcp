---
"adcontextprotocol": minor
---

Add creative delivery reporting to the AdCP specification.

- Add optional `by_creative` metrics breakdown within `by_package` in delivery responses
- Add `get_creative_delivery` task on creative agents for variant-level delivery data with manifests
- Add `creative-variant` core object supporting three tiers: standard (1:1), asset group optimization, and generative creative. Variants include full creative manifests showing what was rendered.
- Extend `preview_creative` with `request_type: "variant"` for post-flight variant previews
- Add `selection_mode` to repeatable asset groups to distinguish sequential (carousel) from optimize (asset pool) behavior
- Add `supports_creative_breakdown` to reporting capabilities
- Add `delivery` creative agent capability
