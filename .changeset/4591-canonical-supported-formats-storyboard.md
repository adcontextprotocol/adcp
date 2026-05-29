---
"adcontextprotocol": minor
---

Add creative-agent canonical `supported_formats` storyboard coverage for 3.1.

The training agent now advertises implemented canonical creative build
capabilities with agent-local `capability_id` values, accepts those IDs as
`build_creative` targets for implemented canonical outputs, rejects unsupported
targets with `FORMAT_NOT_SUPPORTED`, and keeps 3.0 compatibility mode from
accepting 3.1-only capability selectors.
