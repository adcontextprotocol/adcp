---
---

Fix WorkOS domain-verification instructions for apex TXT challenges. When
WorkOS returns a verification token without a `verification_prefix`, the
member-facing Linked Domains and brand-claim flows now tell users to publish
the TXT record at the domain apex instead of falling back to `_workos.<domain>`.
