---
---

Fix: Improve error handling for admin role updates to owner

- Added pre-check to verify the target role exists in WorkOS before attempting the update
- Returns actionable error message if role is not configured
- Stricter validation for WorkOS membership ID format
- Enhanced error logging with WorkOS-specific error details
- Never expose raw WorkOS API errors to users
