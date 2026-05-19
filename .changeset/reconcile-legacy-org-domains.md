---
---

Add `server/src/scripts/reconcile-legacy-org-domains.ts` — a one-shot reconciliation pass for legacy corporate orgs that have `organizations.email_domain` populated but no `organization_domains.verified=true` row. PR #4648 hardened the agent-hostname gate by dropping the `email_domain` soft-pass (the column is writable by an unverified WorkOS-domain webhook), so those orgs hard-fail on new agent registrations. The script auto-seeds verified rows for orgs that have at least one membership row whose email lives at the email_domain (real-human-at-that-domain trust signal); flags everything else for ops review. Dry-run by default; `--apply` writes. Closes #4672.
