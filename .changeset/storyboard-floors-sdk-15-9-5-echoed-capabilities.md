---
"adcontextprotocol": patch
---

Adjust the training-agent 3.0-compat storyboard floors for `@adcp/sdk` 15.9.5, which validates `get_adcp_capabilities` against the release the agent echoed. The runner serves the agent over an http loopback base for `webhook_emission`, so that storyboard's capability step can't satisfy the echoed 3.2 schema's https `identity.brand_json_url` and is now a 3.0-compat known-failing skip. The passing-step floors for signals, governance and creative each drop by one. No schema, task or storyboard content changes.
