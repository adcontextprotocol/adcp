---
---

Handle unsupported compliance cache versions as a target-mismatch diagnostic instead of a platform error.

Addie, registry, and heartbeat callers now surface sellers that advertise only older `adcp.supported_versions` consistently, with safer supported-version parsing and clearer dashboard/API copy. No protocol or schema release is required; this is hosted compliance behavior and OpenAPI documentation.
