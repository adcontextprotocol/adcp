---
---

fix(training-agent): stamp webhook `protocol` with the AdCP domain, not `'mcp'`

The completion-webhook envelope emitted `protocol: 'mcp'` (transport name), but
`core/mcp-webhook-payload.json` references `enums/adcp-protocol.json`, whose
values are the AdCP domain (`media-buy`, `signals`, `governance`, `creative`,
`brand`, `sponsored-intelligence`). Any strict validator would reject the
legacy value.

Adds `TOOL_TO_PROTOCOL` mapping keyed off `TOOL_TO_TASK_TYPE` so tsc enforces
both maps stay in sync. Creative + account operations stamp `media-buy`
(matching the `sync_creatives → media-buy` example in the payload schema);
signals / governance / brand stamp their own domain.
