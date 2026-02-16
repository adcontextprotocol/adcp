---
"adcontextprotocol": major
---

Remove `proposal_id` from get_products request schema

Proposal refinement now uses protocol-level session continuity (`context_id` in MCP, `contextId` in A2A) instead of a task-level parameter. This makes refinement consistent across get_products, get_signals, and build_creative. Proposal execution via create_media_buy is unchanged.
