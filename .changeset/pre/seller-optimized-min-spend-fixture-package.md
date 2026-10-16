---
"adcontextprotocol": patch
---

Compliance: in the `seller_optimized_budget` storyboard, place the positive minimum-spend target on the second (retargeting) package instead of the first. The `@adcp/sdk` storyboard request builder authors a package budget on the first package of every `create_media_buy` step, which made a minimum-spend target on that package exceed its own injected cap for a seller that declares both package caps and minimum-spend targets. The target-versus-cap contradiction stays graded by `seller_optimized_min_spend_target_exceeds_package_cap`.
