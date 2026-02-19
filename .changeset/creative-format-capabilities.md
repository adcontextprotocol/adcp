---
"adcontextprotocol": minor
---

Add build capability discovery to creative formats.

`format.json` gains `input_format_ids` — the source creative formats a format accepts as input manifests (alongside the existing `output_format_ids` for what can be produced).

`list_creative_formats` gains two new filter parameters:
- `output_format_ids` — filter to formats that can produce any of the specified outputs
- `input_format_ids` — filter to formats that accept any of the specified formats as input

Together these let agents ask a creative agent "what can you build?" and query in either direction: "given outputs I need, what inputs do you accept?" or "given inputs I have, what outputs can you produce?"
