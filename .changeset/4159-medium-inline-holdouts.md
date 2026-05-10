---
---

Server: migrate two of the three remaining inline `organization_domains` writers in `routes/admin/domains.ts`. Adds `unlinkDomainAndReselectPrimary` (admin-flavor: any source, reselect prefers verified) and uses it in the admin DELETE handler. Bulk domain-health sync rewritten as a SELECT-then-`linkDomain` loop. Reassign-from-personal cleanup stays inline by design — its `email_domain = $2` defensive filter has reason. #4159 cleanup.
