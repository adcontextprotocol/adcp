---
---

Fix org profile page always showing "Register an agent to start integrating" CTA by replacing the hardcoded `agentCount = 0` stub in `assembleOrgHealth` with a real query against `member_profiles.agents`. Orgs with registered agents will now correctly see their tech-integration health score reflect actual registrations and will no longer see the spurious onboarding CTA.
