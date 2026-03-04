---
---

Fix join request approval failing with "Email already invited to organization" when a stale pending invitation exists. Approval now directly creates org membership using the requester's existing user ID instead of sending an invitation.
