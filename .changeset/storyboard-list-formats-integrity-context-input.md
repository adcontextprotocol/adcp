---
---

fix(storyboards): inject `format_ids[0]` via `context_inputs` in `media_buy_seller / list_formats_integrity` (closes #2848)

The `@adcp/client` (≤5.11) `list_creative_formats` request builder returns `{}`
and discards the storyboard's `sample_request`, so the `format_ids:
[$context.product_format_id]` filter never reaches the wire and the seller
answers with its full format catalog. The `formats[0].format_id` round-trip
assertion then fails on a coincidence (`display_static` ≠ the captured
`sponsored_product`) rather than because the seller actually substituted a
format. The training-agent's filter logic was already correct.

Use the runner's `context_inputs` (applied after the builder) to inject the
captured `{agent_url, id}` object at `format_ids[0]`. Drop once
adcontextprotocol/adcp-client#797 ships and we bump the SDK pin.

Second sub-issue from #2848 (`creative_fate_after_cancellation` sync_creatives
shape) was already addressed by #2867 / #2850.
