---
"adcontextprotocol": patch
---

Fix onboarding redirect and add org admin audit tool

- Remove ?signup parameter check in onboarding - users with existing org memberships now always redirect to dashboard
- Add admin tool to audit organizations without admins
- Auto-fix single-member orgs; flag multi-member orgs for manual review
