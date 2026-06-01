---
"adcontextprotocol": patch
---

Membership dashboard now treats org-level agreement state as the pre-payment source of truth. Standalone agreement acceptance immediately updates the card, checkout skips the redundant agreement modal when the current version is already accepted, and invoice requests hide the agreement checkbox when the current version is already on file. Stale stored agreement versions are rejected server-side so prospects are asked to accept the current agreement before invoicing.
