---
---

Add registry infrastructure: authentication, billing, and testing.

This PR adds the infrastructure needed for the AdCP registry but does not modify
the core protocol specification, schemas, or APIs. Changes include:

**Authentication System:**
- WorkOS AuthKit integration for user authentication
- Session management with encrypted cookies
- Role-based access control middleware
- OAuth callback handling

**Billing Integration:**
- Stripe billing integration for subscriptions
- Customer and subscription management
- Webhook handlers for subscription events
- Stripe Customer Portal and Pricing Table support

**Database Schema:**
- Organizations table with billing fields
- Agreement management and audit logging
- PostgreSQL database integration

**Testing Infrastructure:**
- Jest unit tests for billing and database code
- 92.3% coverage on Stripe client
- Comprehensive test suite for authentication flows

**UI Pages:**
- Onboarding flow (/onboarding)
- Dashboard page (/dashboard)

These changes are registry-specific infrastructure and do not affect the AdCP
protocol specification, versioning, or client/server compatibility.
