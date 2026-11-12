---
"adcontextprotocol": minor
---

Add the optional creative.supports_registry_policy_enforcement capability and
gate the creative/policy_backed_rejections storyboard on explicit support, so
sellers that do not publish registry policies in enforced_policies report that
coverage as not applicable instead of failing it. A creative library alone does
not imply support, and a seller that publishes a policy must still enforce it.
The reference seller advertises the flag on the 3.3 contract.
