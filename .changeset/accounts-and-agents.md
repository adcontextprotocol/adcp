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
- `agent.json`: Entity operating on accounts (brand team, agency, automated system)
- `list-accounts-request.json` / `list-accounts-response.json`: Discover accessible accounts

Updated schemas:
- `media-buy.json`: Added account attribution
- `create-media-buy-request.json`: Added optional `account_id` field
- `create-media-buy-response.json`: Added account in response
- `get-products-request.json`: Added optional `account_id` for rate card context

Deprecates the "Principal" terminology in favor of the more precise Account/Agent distinction.
