---
"adcontextprotocol": patch
---

Fix: Improve error handling for admin role updates to owner

Root cause investigation and fix:
- The WorkOS error "The string did not match the expected pattern" occurs when trying to assign a role that doesn't exist in the organization
- WorkOS only creates a default "member" role; "owner" and "admin" must be configured separately
- Added pre-check to verify the target role exists in WorkOS before attempting the update
- Returns actionable error message if role is not configured: "The 'owner' role is not configured for this organization"

Additional improvements:
- Stricter validation for WorkOS membership ID format (must match pattern `om_[A-Za-z0-9]{20,30}`)
- Separate try-catch blocks for getOrganizationMembership and updateOrganizationMembership calls
- Enhanced error logging with WorkOS-specific error details (code, errors, requestID)
- Never expose raw WorkOS API errors to users
- Applied consistent improvements to both admin role update endpoints (accounts.ts and members.ts)
