# Products-only brief compatibility vectors

These vectors pin the valid established flow for AdCP 2.5, 3.0, and 3.1:

1. `get_products` brief discovery returns usable products and no proposal.
2. The compact projection returns `products_available` without inventing a
   proposal, commercial terms, terms digest, or feed/pricing fence.
3. The fail-closed `legacy_create` continuation names both missing atomic
   fences and is redeemed through the typed SDK-local
   `continueLegacyPurchase` input before routing the selected product to that
   version's `create_media_buy` request. AdCP 2.5 also names
   `mutation_idempotency_not_guaranteed`, since that release has no mutation
   replay contract; the follow-up must accept every returned loss.
4. The seller-fenced `listed_purchase` branch carries real account-scoped feed
   and pricing versions unchanged into `buy_products`.
5. A 3.2 seller's established facades preserve the reverse direction:
   products-only legacy discovery remains executable through legacy create.

The negative assertions pin product substitution, package-selection drift,
and incomplete loss consent. SDK suites consume the same vectors to exercise
expiry, principal/account binding, atomic token claim, exact retry, and crash
reconciliation against their durable coordinator implementations.

The `legacy_create` continuation is deprecated compatibility behavior for the
AdCP 3.x window and is removable in AdCP 4.0.
