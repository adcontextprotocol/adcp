---
"adcontextprotocol": minor
---

Close five gaps in the 3.3 account-attribute model found while implementing against beta.1.

- **"Yes, but as a separate account."** A `request_account` change request can now resolve as `created`, with a new `account_id` carrying the requested change, or as `matched`, pointing to an account the caller already holds. In both cases the named account is untouched. The seller MUST NOT move media buys, creatives, or reporting between the accounts; the buyer chooses which one carries new buys. A buyer tells these outcomes apart because the resolved `account_id` differs from `requested.account_id`. `enums/account-request-resolution.json` and `core/account-request-record.json` describe the change-request meanings.
- **A refused `sync_accounts` update is visible.** On a settings-update row whose change the seller is reviewing (`pending_approval`), a seller that supports `account.requests` MUST include the review's `request_id`. The request resolves as a `request_account` change does (`updated`, `created`, `matched`, or `rejected`), so a refusal no longer looks the same as a review that is still running.
- **Accounts that end up alike.** An attribute change that leaves an account with the same brand, operator, and attributes as another account is not a conflict. Both keep their `account_id`, media buys, and history, and the seller MUST NOT merge them. Natural-key references that match both return `ACCOUNT_AMBIGUOUS`, and the deprecated `ACCOUNT_IDENTITY_CONFLICT` does not apply.
- **What `countries` mean.** `brand.countries` declares the markets an account serves. A seller MAY use it to decide products, prices, terms, and reviews, and MAY refuse a new buy or package whose targeting reaches a market outside it. It never targets delivery. Narrowing it never changes, pauses, or cancels an accepted media buy or its targeting, pricing, or terms, and widening it never extends an accepted buy.
- **Migration guide.** It now says what a 3.3 buyer does when a 3.0 to 3.2 seller can't take a `countries` change: keep using the existing account reference, and open a new account only by choice.
