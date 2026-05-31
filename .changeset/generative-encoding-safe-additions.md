---
"adcontextprotocol": minor
---

spec(creative): generative-encoding safe additions — `free_text` params + per-output transformer pricing.

The additive half of the generative-agent (Veo/Imagen) encodings follow-on. The two *normative* rules it pairs with — generation count is owned by `max_variants`/`max_creatives` (never a config param), and `aspect_ratio` rides the format axis — are intentionally left to the working group; only the safe schema bits land here.

- `transformer-param.json` `value_source` gains **`free_text`** (an open buyer-authored string with no closed set — e.g. a `negative_prompt` or style note; `type` MUST be `string`, the closed-set fields MUST be absent) plus an optional **`max_length`**. The description also states that count/quantity knobs MUST NOT be params (count rides `max_variants`/`max_creatives`).
- `vendor-pricing-option.json` gains optional **`applies_to_output_format_ids`** so one creative transformer can price different outputs differently (e.g. a multi-publisher template charging per publisher format); an unscoped option is the default. Additive and inert for non-creative vendors (signals/governance) — **flagged for shared-schema owner ack**.
