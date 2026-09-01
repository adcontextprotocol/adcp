/**
 * Owner-sold supply-path verifier.
 *
 * Computes the verification state of one owner-sold carriage path — a
 * channel owner's sales agent selling the owner's collection on a host
 * property — by joining the owner's and host's adagents.json manifests
 * plus the host's ads.txt/app-ads.txt inventorypartnerdomain lines.
 *
 * The states are the ladder defined in
 * docs/media-buy/product-discovery/collections-and-installments.mdx
 * ("Verification states"):
 *
 *   verified_owner_sold — the host's adagents.json authorizes the agent
 *     for the host property, narrowed by the owner's collection selector
 *     (exact or bulk grant). Enforcement-grade.
 *   host_delegated — no collection-scoped host entry, but the host's
 *     ads.txt names the owner via inventorypartnerdomain= and the
 *     owner's own adagents.json names the agent and the collection.
 *   owner_attested — only the owner's distribution[] asserts carriage.
 *     Discovery data; MUST NOT be treated as sales authorization.
 *   unverified — none of the above.
 *
 * The verdict is deliberately evidence-bearing: every leg reports what
 * was checked and why it failed, so callers can reproduce the conclusion
 * from the authoritative files and fix the failing leg (most early
 * failures are cross-file typos, not policy).
 */

import { canonicalizePublisherDomain } from './publisher-domain.js';
import { entryPropertyScope } from './carriage-confirmation.js';
import { canonicalizeAgentUrl, type AdagentsManifest, type AdagentsAuthorizedAgent } from '../db/publisher-db.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SupplyPathState =
  | 'verified_owner_sold'
  | 'host_delegated'
  | 'owner_attested'
  | 'unverified';

export type OwnerCollectionFailure =
  | 'manifest_not_found'
  | 'no_collections_declared'
  | 'collection_not_declared';

export type OwnerCarriageFailure =
  | 'collection_leg_failed'
  | 'no_distribution_for_host'
  | 'property_ids_unresolved'
  | 'host_manifest_not_found';

export type OwnerAgentFailure =
  | 'manifest_not_found'
  | 'agent_not_declared_by_owner';

export type HostAuthorizationFailure =
  | 'manifest_not_found'
  | 'no_agent_entry'
  | 'collection_scope_mismatch'
  | 'property_scope_mismatch';

export interface Leg<F extends string> {
  ok: boolean;
  failure?: F;
  detail?: string;
}

export interface SupplyPathLegs {
  /** Owner's adagents.json declares the collection (kind noted in detail). */
  owner_collection_declared: Leg<OwnerCollectionFailure>;
  /** The collection's distribution[] names the host, and any property_ids resolve in the host manifest. */
  owner_distribution_carriage: Leg<OwnerCarriageFailure> & {
    property_ids_matched?: string[];
    property_ids_unmatched?: string[];
  };
  /** Owner's own adagents.json lists the sales agent. */
  owner_agent_declared: Leg<OwnerAgentFailure>;
  /** Host adagents.json authorizes the agent for the property, collection-scoped. */
  host_authorization: Leg<HostAuthorizationFailure> & {
    matched_entry?: {
      url: string;
      authorization_type?: string;
      delegation_type?: string;
      collections?: Array<{ publisher_domain: string; collection_ids?: string[] }>;
    };
  };
  /** Host ads.txt / app-ads.txt names the owner via inventorypartnerdomain=. */
  inventory_partner_domain: Leg<'not_declared' | 'ads_txt_unavailable'>;
}

export interface SupplyPathVerdict {
  state: SupplyPathState;
  legs: SupplyPathLegs;
}

export interface SupplyPathInput {
  /** Canonicalized owner (channel publisher) domain. */
  ownerDomain: string;
  /** Canonicalized host (carrying property publisher) domain. */
  hostDomain: string;
  /** Seller agent URL as the buyer sees it. */
  agentUrl: string;
  /** Owner-assigned collection ID. Omit to verify the path at domain level (bulk deals). */
  collectionId?: string;
  ownerManifest: AdagentsManifest | null;
  hostManifest: AdagentsManifest | null;
  /**
   * inventorypartnerdomain values from the host's ads.txt/app-ads.txt,
   * already canonicalized. null = the files could not be fetched (distinct
   * from fetched-and-absent, which is an empty array).
   */
  hostInventoryPartnerDomains: string[] | null;
}

// ─── ads.txt parsing ─────────────────────────────────────────────────────────

/**
 * Extract inventorypartnerdomain= values from ads.txt content
 * (IAB ads.txt 1.1 §3.2 variable). Comments after '#' are stripped;
 * values are canonicalized publisher domains.
 */
export function parseInventoryPartnerDomains(adsTxtContent: string): string[] {
  const partners = new Set<string>();
  for (const line of adsTxtContent.split(/\r?\n/)) {
    const match = line.trim().match(/^inventorypartnerdomain\s*=\s*([A-Za-z0-9.-]+)\s*(?:#.*)?$/i);
    if (match?.[1]) {
      const canonical = canonicalizePublisherDomain(match[1]);
      if (canonical) partners.add(canonical);
    }
  }
  return [...partners];
}

// ─── Verification ────────────────────────────────────────────────────────────

interface CollectionRecord extends Record<string, unknown> {
  collection_id?: unknown;
  kind?: unknown;
  distribution?: unknown;
}

function ownerCollections(manifest: AdagentsManifest): CollectionRecord[] {
  return Array.isArray(manifest.collections)
    ? (manifest.collections as CollectionRecord[]).filter((c) => c && typeof c === 'object')
    : [];
}

function hostPropertyIds(manifest: AdagentsManifest): Set<string> {
  const ids = new Set<string>();
  for (const property of Array.isArray(manifest.properties) ? manifest.properties : []) {
    const id = (property as { property_id?: unknown } | null)?.property_id;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}

/** Does the entry's collections constraint cover (ownerDomain, collectionId)? */
function entryCoversCollection(
  entry: AdagentsAuthorizedAgent,
  ownerDomain: string,
  collectionId: string | undefined,
): boolean {
  // No constraint = every collection (a plain property grant is broader
  // than a collection-narrowed one).
  if (!Array.isArray(entry.collections) || entry.collections.length === 0) return true;
  return entry.collections.some((selector) => {
    if (!selector || typeof selector !== 'object') return false;
    const domain = typeof selector.publisher_domain === 'string'
      ? canonicalizePublisherDomain(selector.publisher_domain)
      : null;
    if (domain !== ownerDomain) return false;
    if (selector.collection_ids === undefined) return true; // bulk grant
    if (!Array.isArray(selector.collection_ids)) return false;
    if (collectionId === undefined) return selector.collection_ids.length > 0;
    return selector.collection_ids.includes(collectionId);
  });
}

export function verifySupplyPath(input: SupplyPathInput): SupplyPathVerdict {
  const { ownerDomain, hostDomain, collectionId } = input;
  const agentCanonical = canonicalizeAgentUrl(input.agentUrl);

  // ── Leg 1: owner declares the collection ──────────────────────────────────
  const ownerCollectionLeg: SupplyPathLegs['owner_collection_declared'] = { ok: false };
  let targetCollections: CollectionRecord[] = [];
  if (!input.ownerManifest) {
    ownerCollectionLeg.failure = 'manifest_not_found';
  } else {
    const declared = ownerCollections(input.ownerManifest);
    if (collectionId !== undefined) {
      targetCollections = declared.filter((c) => c.collection_id === collectionId);
      if (targetCollections.length > 0) {
        ownerCollectionLeg.ok = true;
        const kind = targetCollections[0].kind;
        if (typeof kind === 'string') ownerCollectionLeg.detail = `kind: ${kind}`;
      } else {
        ownerCollectionLeg.failure = 'collection_not_declared';
        ownerCollectionLeg.detail =
          `owner declares ${declared.length} collection(s); none has collection_id "${collectionId}"`;
      }
    } else if (declared.length > 0) {
      targetCollections = declared;
      ownerCollectionLeg.ok = true;
      ownerCollectionLeg.detail = `owner declares ${declared.length} collection(s)`;
    } else {
      ownerCollectionLeg.failure = 'no_collections_declared';
    }
  }

  // ── Leg 2: the collection's distribution names the host ───────────────────
  const carriageLeg: SupplyPathLegs['owner_distribution_carriage'] = { ok: false };
  if (!ownerCollectionLeg.ok) {
    carriageLeg.failure = 'collection_leg_failed';
  } else {
    const hostEntries = targetCollections.flatMap((collection) =>
      (Array.isArray(collection.distribution) ? collection.distribution : []).filter(
        (entry: unknown) =>
          !!entry && typeof entry === 'object'
          && typeof (entry as { publisher_domain?: unknown }).publisher_domain === 'string'
          && canonicalizePublisherDomain((entry as { publisher_domain: string }).publisher_domain) === hostDomain,
      ) as Array<{ property_ids?: unknown }>,
    );
    if (hostEntries.length === 0) {
      carriageLeg.failure = 'no_distribution_for_host';
    } else {
      const claimed = [...new Set(hostEntries.flatMap((entry) =>
        Array.isArray(entry.property_ids)
          ? entry.property_ids.filter((id): id is string => typeof id === 'string')
          : []))];
      if (claimed.length === 0) {
        // Identifier-only carriage: asserted, nothing to cross-resolve.
        carriageLeg.ok = true;
        carriageLeg.detail = 'carriage asserted without host property_ids (identifiers only)';
      } else if (!input.hostManifest) {
        carriageLeg.failure = 'host_manifest_not_found';
        carriageLeg.property_ids_unmatched = claimed;
      } else {
        const known = hostPropertyIds(input.hostManifest);
        carriageLeg.property_ids_matched = claimed.filter((id) => known.has(id));
        carriageLeg.property_ids_unmatched = claimed.filter((id) => !known.has(id));
        if (carriageLeg.property_ids_matched.length > 0) {
          carriageLeg.ok = true;
        } else {
          // Dangling cross-file references MUST be treated as unverified
          // carriage (spec: programmed channels and owner-sold carriage).
          carriageLeg.failure = 'property_ids_unresolved';
        }
      }
    }
  }

  // ── Leg 3: owner's own file names the sales agent ─────────────────────────
  const ownerAgentLeg: SupplyPathLegs['owner_agent_declared'] = { ok: false };
  if (!input.ownerManifest) {
    ownerAgentLeg.failure = 'manifest_not_found';
  } else {
    const listed = (Array.isArray(input.ownerManifest.authorized_agents)
      ? input.ownerManifest.authorized_agents
      : []
    ).some((entry) => typeof entry?.url === 'string' && canonicalizeAgentUrl(entry.url) === agentCanonical);
    if (listed) ownerAgentLeg.ok = true;
    else ownerAgentLeg.failure = 'agent_not_declared_by_owner';
  }

  // ── Leg 4: host authorization (the enforcement-grade leg) ─────────────────
  const hostLeg: SupplyPathLegs['host_authorization'] = { ok: false };
  if (!input.hostManifest) {
    hostLeg.failure = 'manifest_not_found';
  } else {
    const agentEntries = (Array.isArray(input.hostManifest.authorized_agents)
      ? input.hostManifest.authorized_agents
      : []
    ).filter((entry) => typeof entry?.url === 'string' && canonicalizeAgentUrl(entry.url) === agentCanonical);
    if (agentEntries.length === 0) {
      hostLeg.failure = 'no_agent_entry';
    } else {
      const collectionCovered = agentEntries.filter((entry) =>
        entryCoversCollection(entry, ownerDomain, collectionId));
      if (collectionCovered.length === 0) {
        hostLeg.failure = 'collection_scope_mismatch';
        hostLeg.detail =
          `${agentEntries.length} entr${agentEntries.length === 1 ? 'y' : 'ies'} for this agent; ` +
          `none has a collections selector covering ${ownerDomain}` +
          (collectionId !== undefined ? `:${collectionId}` : '');
      } else {
        // Property scope: only checkable when the owner's carriage map
        // names host property_ids. When it does, at least one claimed
        // property must be reachable by the entry's scope.
        const claimed = carriageLeg.property_ids_matched ?? [];
        const matched = collectionCovered.find((entry) => {
          if (claimed.length === 0) return true;
          const scope = entryPropertyScope(entry, hostDomain, input.hostManifest!);
          if (scope === null) return true; // publisher-wide
          return claimed.some((id) => scope.has(id));
        });
        if (matched) {
          hostLeg.ok = true;
          hostLeg.matched_entry = {
            url: matched.url ?? input.agentUrl,
            authorization_type: matched.authorization_type,
            delegation_type: (matched as { delegation_type?: string }).delegation_type,
            collections: Array.isArray(matched.collections)
              ? matched.collections.map((selector) => ({
                publisher_domain: String(selector.publisher_domain),
                ...(Array.isArray(selector.collection_ids)
                  ? { collection_ids: selector.collection_ids.filter((id): id is string => typeof id === 'string') }
                  : {}),
              }))
              : undefined,
          };
        } else {
          hostLeg.failure = 'property_scope_mismatch';
          hostLeg.detail =
            `collection scope matches, but no entry authorizes the carried host propert` +
            `${claimed.length === 1 ? 'y' : 'ies'} [${claimed.join(', ')}]`;
        }
      }
    }
  }

  // ── Leg 5: inventorypartnerdomain (interim host-side evidence) ────────────
  const partnerLeg: SupplyPathLegs['inventory_partner_domain'] = { ok: false };
  if (input.hostInventoryPartnerDomains === null) {
    partnerLeg.failure = 'ads_txt_unavailable';
  } else if (input.hostInventoryPartnerDomains.includes(ownerDomain)) {
    partnerLeg.ok = true;
  } else {
    partnerLeg.failure = 'not_declared';
  }

  // ── State ladder ───────────────────────────────────────────────────────────
  // verified requires BOTH sides: the host grant's collection selector is a
  // reference into the owner's adagents.json, and a dangling reference
  // (owner file missing or collection undeclared) fails closed like any
  // other cross-file mismatch.
  let state: SupplyPathState = 'unverified';
  if (hostLeg.ok && ownerCollectionLeg.ok) {
    state = 'verified_owner_sold';
  } else if (partnerLeg.ok && ownerAgentLeg.ok && ownerCollectionLeg.ok) {
    state = 'host_delegated';
  } else if (ownerCollectionLeg.ok && (carriageLeg.ok || carriageLeg.failure === 'property_ids_unresolved' || carriageLeg.failure === 'host_manifest_not_found')) {
    // The owner asserts carriage on this host, with no host-side
    // corroboration. Discovery-only.
    state = 'owner_attested';
  }

  return {
    state,
    legs: {
      owner_collection_declared: ownerCollectionLeg,
      owner_distribution_carriage: carriageLeg,
      owner_agent_declared: ownerAgentLeg,
      host_authorization: hostLeg,
      inventory_partner_domain: partnerLeg,
    },
  };
}
