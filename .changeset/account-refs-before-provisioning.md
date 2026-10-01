---
"adcontextprotocol": minor
---

spec(accounts): clarify and tighten how buyer-declared account references behave before provisioning. A new "Account references before provisioning" section in the accounts overview says:

- a natural key resolves only after the account is provisioned;
- a lazy-provisioning seller provisions only on a provisioning task (one that commits spend or creates account-owned resources), never on discovery or negotiation tasks (`get_products`, `list_products`, `get_signals`, `request_proposals`, `refine_proposals`, `decline_proposals`);
- an `account` that doesn't resolve returns `ACCOUNT_NOT_FOUND` even where `account` is optional, instead of being dropped in favour of public results, which the existing `cache_scope` contract already made a false claim; a lazy-provisioning seller may answer discovery for the account it would create;
- buyers omit `account` and send `brand` until the account is provisioned, and provision before `request_proposals` when they intend to accept;
- account errors describe buyer setup, not seller health;
- an `account_id` echoed by `sync_accounts` for a buyer-declared account is a seller handle that buyers must not assume is accepted as an `AccountRef`.

The provisioning rule narrows earlier "first account-scoped request" wording. It is classified `minor` because a seller that lazily provisioned on `get_products` was conformant before. The wire result is unchanged, because a lazy-provisioning seller may still answer discovery for the account it would create. `ACCOUNT_NOT_FOUND` now gives the same recovery everywhere: provision a natural key, or verify an `account_id`. The capabilities, `get_products`, `get_signals`, `account-ref`, `sync_accounts`, and sandbox texts point to the new section.
