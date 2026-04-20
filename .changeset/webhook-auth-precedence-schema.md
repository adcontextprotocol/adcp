---
---

schemas(push-notification-config): state legacy/9421 precedence in the `authentication` field description

Schema-only readers (SDK authors building off `push-notification-config.json` without cross-referencing `security.mdx`) previously had to infer the precedence rule for the both-present case: seller publishes a 9421 webhook-signing key in adagents.json AND buyer populates `authentication.schemes`. The normative answer already lives in `security.mdx` §Webhook callbacks ("Mode selection is a switch, not both"), but was invisible from the schema alone.

The `authentication` field description now states:

- Presence of the block selects the legacy scheme; absence selects 9421 — a switch, not a fallback.
- Sellers MUST NOT sign both ways; buyers MUST NOT attempt try-9421-then-HMAC verification.
- The seller's always-discoverable baseline 9421 key is not a selector.
- Points at `security.mdx#webhook-callbacks` for the full downgrade-resistance rules (including `webhook_mode_mismatch`).

No normative change — this surfaces existing security.mdx rules at the schema where SDK authors read them. Closes #2503.
