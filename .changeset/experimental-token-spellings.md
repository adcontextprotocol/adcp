---
"adcontextprotocol": minor
---

Give three experimental 3.3 values the spelling their stable or sibling counterpart already uses (adcp#8901). Each was spelled two ways for one concept, and the side that changes is experimental, added in 3.3 and only in the 3.3 betas.

- **`enums/execution-readiness-status.json` (`media_buy.execution_readiness`, #7934, beta.1 to beta.5):** `input_required` becomes `input-required`, the spelling of `enums/task-status.json`, which follows A2A's task states.
- **`enums/creative-change-kind.json` (`creative.live_updates`, #8488, beta.3 to beta.5):** `click_through` becomes `clickthrough`, the `url_type` value the change kind names in `enums/url-asset-type.json`.
- **`enums/delivery-projection-end-state.json` (`media_buy.delivery_projection`, #8043, beta.0 to beta.5):** `underdelivery` becomes `under_delivery`, the spelling of `enums/offer-reason.json`. DR-0029 is amended to the new spelling.

**This changes 3.3.0-beta.0 through beta.5; no stable release has these enums.** The values are renamed in place, with no alias: they are experimental, and the additive-minor check compares against 3.2.x, which has none of the three files. The betas are immutable, so a seller or buyer built from a beta bundle sends and accepts the new spelling: `readiness_status` and the product rollup, `creative.live_updates.in_place[].change`, `staged_update.change_kinds[]` and the `CREATIVE_LIVE_UPDATE_UNSUPPORTED` details, and `projection.projected_end_state`. The training agent classifies creative changes with `clickthrough`.

The consumed changesets for these features stay in `.changeset/pre/` as history.
