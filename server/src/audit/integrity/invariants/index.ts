/**
 * Registry of all integrity invariants. Adding a new invariant:
 *   1. Drop a file in this directory implementing the Invariant contract.
 *   2. Import + add it to ALL_INVARIANTS below.
 *   3. Add a unit test under server/tests/unit/integrity-invariants/.
 *
 * The order here is the order they run in. Cheap, broadly-applicable
 * invariants (DB-only) should come before expensive ones (Stripe / WorkOS
 * round-trips per row).
 */
import type { Invariant } from '../types.js';
import { stripeCustomerOrgMetadataBidirectionalInvariant } from './stripe-customer-org-metadata-bidirectional.js';
import { oneActiveStripeSubPerOrgInvariant } from './one-active-stripe-sub-per-org.js';
import { stripeCustomerResolvesInvariant } from './stripe-customer-resolves.js';
import { orgRowMatchesLiveStripeSubInvariant } from './org-row-matches-live-stripe-sub.js';
import { stripeSubReflectedInOrgRowInvariant } from './stripe-sub-reflected-in-org-row.js';
import { workosMembershipRowExistsInWorkosInvariant } from './workos-membership-row-exists-in-workos.js';
import { usersHavePrimaryOrganizationInvariant } from './users-have-primary-organization.js';
import { everyEntitledOrgHasResolvableTierInvariant } from './every-entitled-org-has-resolvable-tier.js';
import { uniqueOrgPerEmailDomainInvariant } from './unique-org-per-email-domain.js';

export const ALL_INVARIANTS: readonly Invariant[] = [
  // DB-only checks first (no external API calls).
  usersHavePrimaryOrganizationInvariant,
  uniqueOrgPerEmailDomainInvariant,
  everyEntitledOrgHasResolvableTierInvariant,
  stripeCustomerOrgMetadataBidirectionalInvariant,
  oneActiveStripeSubPerOrgInvariant,
  stripeCustomerResolvesInvariant,
  orgRowMatchesLiveStripeSubInvariant,
  stripeSubReflectedInOrgRowInvariant,
  workosMembershipRowExistsInWorkosInvariant,
];

export function getInvariantByName(name: string): Invariant | undefined {
  return ALL_INVARIANTS.find((inv) => inv.name === name);
}
