---
"adcontextprotocol": patch
---

Accept HTTP Basic authentication in the universal `security_baseline` compliance storyboard. Basic credentials now have a dedicated valid/invalid probe path and can satisfy `auth_mechanism_verified` alongside Bearer API keys and OAuth discovery.
