/**
 * Host-side corroboration of a collection carriage claim.
 *
 * A channel owner's `collection.distribution[]` entry asserts that a host
 * property carries the channel. That is publisher-authored discovery data.
 * `hostConfirmsCarriage` computes whether the HOST's own adagents.json
 * affirmatively corroborates the path: some authorized_agents entry names
 * the owner's domain in a collections[] selector (exact collection ID or
 * bulk grant) whose property scope can reach the claimed host properties.
 *
 * This is deliberately STRICTER than authorization matching: an entry with
 * no collections constraint authorizes broadly, but it does not *name* the
 * owner, so it does not confirm carriage — confirmation is an affirmative
 * statement about this owner, not a side effect of a wide grant. It is also
 * agent-free: any sales path the host attests for the owner corroborates
 * the carriage fact, regardless of which agent the buyer would transact
 * with (agent-specific verification is the supply-path verifier's job).
 *
 * Leaf module: only type-only imports from publisher-db so the collection
 * catalog projection can use it without a runtime import cycle.
 */

import { canonicalizePublisherDomain } from './publisher-domain.js';
import type { AdagentsManifest, AdagentsAuthorizedAgent } from '../db/publisher-db.js';

function hostPropertyIdsByTag(manifest: AdagentsManifest): Map<string, Set<string>> {
  const byTag = new Map<string, Set<string>>();
  for (const property of Array.isArray(manifest.properties) ? manifest.properties : []) {
    const record = property as { property_id?: unknown; tags?: unknown } | null;
    if (typeof record?.property_id !== 'string') continue;
    for (const tag of Array.isArray(record.tags) ? record.tags : []) {
      if (typeof tag !== 'string') continue;
      const set = byTag.get(tag) ?? new Set<string>();
      set.add(record.property_id);
      byTag.set(tag, set);
    }
  }
  return byTag;
}

/** Property IDs (host-local) that an authorized_agents entry can reach. null = publisher-wide. */
export function entryPropertyScope(
  entry: AdagentsAuthorizedAgent,
  hostDomain: string,
  hostManifest: AdagentsManifest,
): Set<string> | null {
  switch (entry.authorization_type) {
    case 'property_ids':
      return new Set((entry.property_ids ?? []).filter((id): id is string => typeof id === 'string'));
    case 'property_tags': {
      const byTag = hostPropertyIdsByTag(hostManifest);
      const ids = new Set<string>();
      for (const tag of entry.property_tags ?? []) {
        for (const id of byTag.get(tag) ?? []) ids.add(id);
      }
      return ids;
    }
    case 'inline_properties': {
      const ids = new Set<string>();
      for (const property of entry.properties ?? []) {
        const id = (property as { property_id?: unknown } | null)?.property_id;
        if (typeof id === 'string') ids.add(id);
      }
      return ids;
    }
    case 'publisher_properties': {
      const ids = new Set<string>();
      let coversAll = false;
      for (const selector of entry.publisher_properties ?? []) {
        const singular = typeof selector?.publisher_domain === 'string'
          ? canonicalizePublisherDomain(selector.publisher_domain)
          : null;
        const inPlural = Array.isArray(selector?.publisher_domains)
          && selector.publisher_domains.some(
            (domain) => typeof domain === 'string' && canonicalizePublisherDomain(domain) === hostDomain,
          );
        if (singular !== hostDomain && !inPlural) continue;
        if (selector.selection_type === 'all') coversAll = true;
        for (const id of selector.property_ids ?? []) {
          if (typeof id === 'string') ids.add(id);
        }
        if (selector.selection_type === 'by_tag') {
          const byTag = hostPropertyIdsByTag(hostManifest);
          for (const tag of selector.property_tags ?? []) {
            for (const id of byTag.get(tag) ?? []) ids.add(id);
          }
        }
      }
      return coversAll ? null : ids;
    }
    default:
      // No authorization_type = publisher-wide.
      return null;
  }
}

/** Does the entry AFFIRMATIVELY name (ownerDomain, collectionId) in a collections selector? */
function entryNamesOwnerCollection(
  entry: AdagentsAuthorizedAgent,
  ownerDomain: string,
  collectionId: string,
): boolean {
  if (!Array.isArray(entry.collections)) return false;
  return entry.collections.some((selector) => {
    if (!selector || typeof selector !== 'object') return false;
    const domain = typeof selector.publisher_domain === 'string'
      ? canonicalizePublisherDomain(selector.publisher_domain)
      : null;
    if (domain !== ownerDomain) return false;
    if (selector.collection_ids === undefined) return true; // bulk grant names every owner collection
    return Array.isArray(selector.collection_ids) && selector.collection_ids.includes(collectionId);
  });
}

export interface CarriageConfirmationInput {
  /** Canonicalized channel owner (collection publisher) domain. */
  ownerDomain: string;
  /** Owner-assigned collection ID being carried. */
  collectionId: string;
  /** Canonicalized host domain from the distribution entry. */
  hostDomain: string;
  /** Host property IDs claimed by the distribution entry ([] = identifier-only carriage). */
  claimedPropertyIds: string[];
  /** The host's cached adagents.json, or null when the host has none. */
  hostManifest: AdagentsManifest | null;
}

export function hostConfirmsCarriage(input: CarriageConfirmationInput): boolean {
  const { ownerDomain, collectionId, hostDomain, claimedPropertyIds, hostManifest } = input;
  if (!hostManifest) return false;
  const entries = Array.isArray(hostManifest.authorized_agents)
    ? hostManifest.authorized_agents
    : [];
  return entries.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (!entryNamesOwnerCollection(entry, ownerDomain, collectionId)) return false;
    if (claimedPropertyIds.length === 0) return true;
    const scope = entryPropertyScope(entry, hostDomain, hostManifest);
    if (scope === null) return true; // publisher-wide reach
    return claimedPropertyIds.some((id) => scope.has(id));
  });
}
