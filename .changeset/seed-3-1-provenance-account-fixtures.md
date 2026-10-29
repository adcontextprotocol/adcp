---
"adcontextprotocol": patch
---

Seed the sandbox account required by the three provenance storyboards and creative_reception on 3.1. Each scenario declares the same idempotent brand/operator sandbox fixture and uses an explicit sandbox AccountRef, so cold starts and rotated runs do not rely on another storyboard provisioning it. Register account seeding in the sales training tenant with a bounded replay cache scoped to the authenticated caller, preserving same-caller idempotency and the frozen 3.0 compatibility surface. Existing release artifacts and SDK pins are unchanged.
