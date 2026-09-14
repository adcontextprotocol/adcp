---
"adcontextprotocol": minor
---

Add request-only targeting and product-purchase input schemas for established
and compact create/update surfaces. Each targeting dimension now distinguishes
omission (inherit or preserve), a non-null replacement, and `null` (clear),
while discovery, capability, accepted-commercial-term, and readback schemas
remain strict and non-null.
