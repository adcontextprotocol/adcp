---
"adcontextprotocol": patch
---

Fix compliance reporting for optional-tool skips: storyboard-level `required_tools`
and step-level `requires_tool` skips now remain untested/not applicable in Addie
instead of surfacing as failures. Preview creative checks now declare their
`preview_creative` gate explicitly.
