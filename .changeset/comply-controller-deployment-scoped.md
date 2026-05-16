---
---

docs(spec): tighten `comply_test_controller` visibility rule to deployment-scoped — production deployments MUST NOT expose the tool on any surface (`tools/list`, `compliance_testing` block in `get_adcp_capabilities`, dispatch). Live-mode probes get unknown-tool, not FORBIDDEN. Closes adcontextprotocol/adcp#3986.
