---
"adcontextprotocol": minor
---

Add `managed_by` redirect field to adagents.json specification.

Publishers can now delegate their advertising operations to a third-party manager using the `managed_by` field. When present, buyer agents should fetch the authoritative adagents.json from the managing domain instead of the publisher's domain.

**New schema field:**
- `managed_by` - Optional domain string that redirects to the managing entity's adagents.json

**Common use cases:**
- Multi-brand networks (Instagram/Facebook → meta.com)
- DOOH networks (individual venues → network operator)
- Publisher consortiums (members → consortium operator)
- White-label platforms (publishers → platform provider)

**Schema changes:**
- Added optional `managed_by` field to adagents.json
- Schema now requires EITHER `authorized_agents` OR `managed_by` (via oneOf)
- Added validation pattern for domain format
- Added examples showing redirect patterns

**Documentation updates:**
- New "Managed By Redirects" section explaining the feature
- Updated Real-World Examples to show Meta network using managed_by
- Added DOOH network example with venue-level redirects
- Security considerations and validation flow guidance
