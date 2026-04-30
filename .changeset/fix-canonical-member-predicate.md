---
---

fix(addie): align is_member/is_paying_member predicates in relationship-context.ts with canonical MEMBER_FILTER

A canceled-but-still-in-period subscription was read as paying in Addie's context. Both loadCompanyInfo and loadOrgMemberships now fetch subscription_canceled_at and delegate to a shared isPayingMembership() helper in org-filters.ts, matching every other membership gate in the system.
