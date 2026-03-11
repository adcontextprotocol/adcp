---
"adcontextprotocol": minor
---

Move sandbox capability from `media_buy.features.sandbox` to `account.sandbox` in `get_adcp_capabilities`. Sandbox is account-level, not a media-buy protocol feature — sellers declare it alongside other account capabilities like `supported_billing` and `account_financials`.
