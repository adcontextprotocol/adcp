---
---

Fix server startup when authentication is not configured

Make WorkOS authentication features optional to allow the server to start without authentication environment variables. This fixes deployment issues where DATABASE_URL is configured but authentication services (WorkOS, Stripe) are not yet set up.

**Changes:**
- WorkOS client initialization is now conditional on having all required auth env vars
- Auth routes are only registered when authentication is properly configured
- Server logs clear warnings when auth features are disabled
- Authentication routes gracefully handle missing WorkOS client
- Fix ES module import error (require() → import statements)

**Note:** This is an internal deployment fix with no API changes, hence no version bump.
