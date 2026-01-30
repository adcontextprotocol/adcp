---
"adcontextprotocol": minor
---

Add accounts and agents specification to AdCP protocol.

AdCP now distinguishes three entities in billable operations:
- **Brand**: Whose products are advertised (identified by brand manifest)
- **Account**: Who gets billed, what rates apply (identified by `account_id`)
- **Agent**: Who is placing the buy (identified by authentication token)

New schemas:
- `account.json`: Billing relationship with rate cards, payment terms, credit limits
- `list-accounts-request.json` / `list-accounts-response.json`: Discover accessible accounts

Updated schemas:
- `media-buy.json`: Added account attribution
- `create-media-buy-request.json`: Added optional `account_id` field
- `create-media-buy-response.json`: Added account in response
- `get-products-request.json`: Added optional `account_id` for rate card context
- `sync-creatives-request.json`: Added optional `account_id` field for creative ownership
- `sync-creatives-response.json`: Added account attribution in response
- `list-creatives-response.json`: Added account attribution per creative
- `creative-filters.json`: Added `account_ids` filter for querying by account

Deprecates the "Principal" terminology in favor of the more precise Account/Agent distinction.
