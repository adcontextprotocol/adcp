---
"adcontextprotocol": patch
---

Fix the four compliance storyboards present on the 3.1 maintenance line that incorrectly included `get_adcp_capabilities` in `required_tools` alongside capability-specific tools: `billing_gate_dispatch`, `billing_out_of_band`, `canonical_supported_formats`, and `evaluator_auth`.

Removing the universal capability-discovery tool prevents agents without the storyboard's capability-specific tools from entering through the per-storyboard OR gate. This backports the applicable subset of #6774; the other 13 storyboards changed on main do not exist on this line.
