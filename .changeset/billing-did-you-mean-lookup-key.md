---
---

Surface `did_you_mean` in Addie billing tool responses when the LLM passes a non-canonical `lookup_key` alias (e.g. `explorer_annual` instead of `aao_membership_explorer_50`). Tighten tool descriptions on `create_payment_link`, `send_invoice`, and `confirm_send_invoice` to explicitly forbid constructing the key from tier name and billing interval. Closes #2550.

Server-side Addie change only — no protocol schema changes.
