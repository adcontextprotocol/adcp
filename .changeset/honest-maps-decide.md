---
"adcontextprotocol": patch
---

Add debug logging support to Addie's AdCP tools and clarify probe vs test behavior.

- Add `debug` parameter to all 10 AdCP tool schemas (get_products, create_media_buy, etc.)
- Include debug_logs in tool output when debug mode is enabled
- Remove redundant `call_adcp_agent` tool (individual tools provide better schema validation)
- Fix `probe_adcp_agent` messaging to clarify it only checks connectivity, not protocol compliance
