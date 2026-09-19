/**
 * Pure, fail-closed implementation of the adcp#6897 verification ladder.
 * Inputs are evidence, never seller-supplied verdicts. Each collection is
 * evaluated independently so domain-level queries cannot join unrelated legs.
 */
import { resolveAgentProperties } from '@adcp/sdk';
import {
  parsePublisherPropertySelector,
  expandPublisherPropertySelector,
} from '@adcp/sdk';
import type { AdAgentsJson, AuthorizedAgent } from '@adcp/sdk';
import type { SupplyPathInput, SupplyPathLegs, SupplyPathManifest, SupplyPathVerdict } from './supply-path-contract.js';
import { agentIdentity, domain, record, records, strings } from './supply-path-input.js';

export const SUPPLY_PATH_STATES = ['unverified', 'owner_attested', 'host_delegated', 'verified_owner_sold'] as const;

const PROPERTY_TYPES = new Set([
  'website', 'mobile_app', 'ctv_app', 'desktop_app', 'dooh', 'podcast', 'radio',
  'linear_tv', 'streaming_audio', 'ai_assistant',
]);
const PROPERTY_IDENTIFIER_TYPES = new Set([
  'domain', 'subdomain', 'network_id', 'ios_bundle', 'android_package',
  'apple_app_store_id', 'google_play_id', 'roku_store_id', 'fire_tv_asin',
  'samsung_app_id', 'apple_tv_bundle', 'bundle_id', 'venue_id', 'screen_id',
  'openooh_venue_type', 'rss_url', 'apple_podcast_id', 'spotify_collection_id',
  'podcast_guid', 'station_id', 'facility_id',
]);
const PROPERTY_CHANNELS = new Set([
  'display', 'olv', 'social', 'search', 'ctv', 'linear_tv', 'radio',
  'streaming_audio', 'podcast', 'dooh', 'ooh', 'print', 'cinema', 'email',
  'gaming', 'retail_media', 'influencer', 'affiliate', 'product_placement',
  'sponsored_intelligence',
]);

export function parseInventoryPartnerDomains(content: string): string[] {
  const partners = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^inventorypartnerdomain\s*=\s*([A-Za-z0-9.-]+)\s*(?:#.*)?$/i);
    const value = match ? domain(match[1]) : null;
    if (value) partners.add(value);
  }
  return [...partners];
}

function revoked(manifest: SupplyPathManifest, publisher: string): boolean {
  if (manifest.revoked_publisher_domains === undefined) return false;
  if (!Array.isArray(manifest.revoked_publisher_domains)) return true;
  return manifest.revoked_publisher_domains.some(
    item =>
      !domain(record(item) ? item.publisher_domain : item) ||
      domain(record(item) ? item.publisher_domain : item) === publisher
  );
}

function coversCollection(entry: Record<string, unknown>, owner: string, id: string | undefined): boolean {
  // Absent is an unconstrained property grant; present malformed is never broad.
  if (entry.collections === undefined) return true;
  if (!Array.isArray(entry.collections) || entry.collections.length === 0) return false;
  if (
    !entry.collections.every(
      selector =>
        record(selector) &&
        domain(selector.publisher_domain) &&
        (selector.collection_ids === undefined || strings(selector.collection_ids))
    )
  )
    return false;
  return entry.collections.some(
    selector =>
      domain(selector.publisher_domain) === owner &&
      (selector.collection_ids === undefined || (id !== undefined && selector.collection_ids.includes(id)))
  );
}

function hasPropertyAuthorizationEnvelope(entry: Record<string, unknown>): boolean {
  const propertyToken = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z0-9_]+$/.test(value);
  const propertyTokens = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every(propertyToken);
  const optionalUniqueList = (value: unknown, valid: (item: unknown) => boolean): boolean =>
    value === undefined || (Array.isArray(value) && value.every(valid) && new Set(value).size === value.length);
  const validInlineProperty = (value: unknown): boolean => {
    if (!record(value) || typeof value.property_type !== 'string' || !PROPERTY_TYPES.has(value.property_type) ||
      typeof value.name !== 'string' ||
      !Array.isArray(value.identifiers) || value.identifiers.length === 0) return false;
    if (value.property_id !== undefined && !propertyToken(value.property_id)) return false;
    if (value.publisher_domain !== undefined && typeof value.publisher_domain !== 'string') return false;
    if (!optionalUniqueList(value.tags, propertyToken) ||
      !optionalUniqueList(value.supported_channels, item => typeof item === 'string' && PROPERTY_CHANNELS.has(item))) {
      return false;
    }
    return value.identifiers.every(identifier => record(identifier) &&
      typeof identifier.type === 'string' && PROPERTY_IDENTIFIER_TYPES.has(identifier.type) &&
      typeof identifier.value === 'string');
  };
  if (entry.authorization_type === 'property_ids') return propertyTokens(entry.property_ids);
  if (entry.authorization_type === 'property_tags') return propertyTokens(entry.property_tags);
  if (entry.authorization_type === 'inline_properties') {
    return Array.isArray(entry.properties) && entry.properties.length > 0 && entry.properties.every(validInlineProperty);
  }
  if (entry.authorization_type === 'publisher_properties') {
    if (!Array.isArray(entry.publisher_properties) || entry.publisher_properties.length === 0 ||
      !entry.publisher_properties.every(record)) return false;
    try {
      entry.publisher_properties.forEach(selector => parsePublisherPropertySelector(selector));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function hasPropertyEnvelope(p: Record<string, unknown>): boolean {
  return (
    typeof p.property_type === 'string' && PROPERTY_TYPES.has(p.property_type) &&
    typeof p.name === 'string' &&
    Array.isArray(p.identifiers) && p.identifiers.length > 0
  );
}

/** Resolve one entry at a time: separate grants are alternatives, never merged across collection scopes. */
function propertyScope(
  entry: Record<string, unknown>,
  host: string,
  manifest: SupplyPathManifest,
  requirePublisher = false
): Set<string> {
  if (revoked(manifest, host)) return new Set();
  if (
    !['property_ids', 'property_tags', 'publisher_properties', 'inline_properties'].includes(
      String(entry.authorization_type)
    )
  )
    return new Set();
  if (entry.authorization_type === 'publisher_properties') {
    if (!Array.isArray(entry.publisher_properties) || entry.publisher_properties.length === 0) return new Set();
    const properties = records(manifest.properties).filter(
      p => hasPropertyEnvelope(p) &&
           ((p.publisher_domain === undefined && !requirePublisher) || domain(p.publisher_domain) === host)
    );
    const ids = new Set<string>();
    try {
      for (const raw of entry.publisher_properties) {
        const selector = parsePublisherPropertySelector(raw);
        if ('property_ids' in selector && !strings(selector.property_ids)) return new Set();
        if ('property_tags' in selector && !strings(selector.property_tags)) return new Set();
        for (const single of expandPublisherPropertySelector(selector)) {
          if (domain(single.publisher_domain) !== host) continue;
          for (const property of properties) {
            if (typeof property.property_id !== 'string') continue;
            if (
              single.selection_type === 'all' ||
              (single.selection_type === 'by_id' && single.property_ids.includes(property.property_id)) ||
              (single.selection_type === 'by_tag' &&
                strings(property.tags) &&
                property.tags.some(t => single.property_tags.includes(t)))
            ) {
              ids.add(property.property_id);
            }
          }
        }
      }
    } catch {
      return new Set();
    }
    return ids;
  }
  if (entry.authorization_type === 'property_ids' && !strings(entry.property_ids)) return new Set();
  if (entry.authorization_type === 'property_tags' && !strings(entry.property_tags)) return new Set();
  // Reuse discovery's discriminator, missing-selector, and revocation semantics.
  if (manifest.properties !== undefined && (!Array.isArray(manifest.properties) || !manifest.properties.every(record)))
    return new Set();
  if (
    entry.authorization_type === 'inline_properties' &&
    (!Array.isArray(entry.properties) || !entry.properties.every(record))
  )
    return new Set();
  const result = resolveAgentProperties(
    { ...manifest, authorized_agents: [entry as unknown as AuthorizedAgent] } as AdAgentsJson,
    String(entry.url)
  );
  return new Set(
    result.properties
      .filter(p => (p.publisher_domain === undefined && !requirePublisher) || domain(p.publisher_domain) === host)
      .map(p => p.property_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
}

export function isUnqualifiedPropertySelector(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).every(key =>
      ['publisher_domain', 'publisher_domains', 'selection_type', 'property_ids', 'property_tags'].includes(key)
    )
  );
}

const UNDERSTOOD_GRANT_FIELDS = new Set([
  'url',
  'authorized_for',
  'authorization_type',
  'property_ids',
  'property_tags',
  'properties',
  'publisher_properties',
  'collections',
  'delegation_type',
  'exclusive',
  'signing_keys',
  'encryption_keys',
  'last_updated',
]);
function unsupportedConstraints(entry: Record<string, unknown>): string[] {
  // Unknown extensions may narrow authorization. They need a reviewed semantic
  // version before this context-free verifier can safely accept the entry.
  const unknown = Object.keys(entry).filter(key => !UNDERSTOOD_GRANT_FIELDS.has(key));
  for (const selector of records(entry.collections)) {
    unknown.push(
      ...Object.keys(selector)
        .filter(key => !['publisher_domain', 'collection_ids'].includes(key))
        .map(key => `collections[].${key}`)
    );
  }
  for (const selector of records(entry.publisher_properties)) {
    unknown.push(
      ...Object.keys(selector)
        .filter(
          key =>
            !['publisher_domain', 'publisher_domains', 'selection_type', 'property_ids', 'property_tags'].includes(key)
        )
        .map(key => `publisher_properties[].${key}`)
    );
  }
  return unknown;
}

/** Bound nested input and worst-case selector work before any traversal. */
function nodeCost(value: unknown): number {
  const stack = [value];
  let cost = 0;
  while (stack.length) {
    const item = stack.pop();
    if (++cost > 32768) return Infinity;
    if (typeof item === 'string' && item.length > 8192) return Infinity;
    if (Array.isArray(item)) {
      if (item.length > 1024) return Infinity;
      stack.push(...item);
    } else if (record(item)) {
      const values = Object.values(item);
      if (values.length > 1024) return Infinity;
      stack.push(...values);
    }
  }
  return cost;
}

function limitVerdict(): SupplyPathVerdict {
  const failure = { ok: false, failure: 'evaluation_limit_exceeded' as const };
  return {
    semantics_version: '1',
    state: 'unverified',
    legs: {
      owner_collection_declared: { ...failure },
      owner_distribution_carriage: { ...failure },
      owner_agent_declared: { ...failure },
      host_authorization: { ...failure },
      inventory_partner_domain: { ...failure },
    },
  };
}

export function verifySupplyPath(input: SupplyPathInput): SupplyPathVerdict {
  const total = nodeCost(input);
  if (!Number.isFinite(total)) return limitVerdict();
  const grants = nodeCost(input.hostManifest?.authorized_agents);
  const properties = nodeCost(input.hostManifest?.properties);
  const collections = records(input.ownerManifest?.collections).length;
  if (!Number.isFinite(total) || grants * properties + Math.max(1, collections) * total * 4 > 4_000_000) {
    return limitVerdict();
  }
  // Bulk inquiry is existential over complete individual paths, not a union
  // of owner collection A's carriage and collection B's host authorization.
  if (input.collectionId === undefined) {
    const collections = records(input.ownerManifest?.collections).filter(
      c => typeof c.collection_id === 'string' && c.collection_id.length > 0
    );
    if (collections.length) {
      const verdicts = collections.map(c => verifySupplyPath({ ...input, collectionId: c.collection_id as string }));
      return verdicts.reduce((best, next) =>
        SUPPLY_PATH_STATES.indexOf(next.state) > SUPPLY_PATH_STATES.indexOf(best.state) ? next : best
      );
    }
  }
  const owner = domain(input.ownerDomain);
  const host = domain(input.hostDomain);
  const agent = agentIdentity(input.agentUrl);
  const ownerManifest = record(input.ownerManifest) ? input.ownerManifest : null;
  const hostManifest = record(input.hostManifest) ? input.hostManifest : null;
  const isRevoked = (role: 'owner' | 'host', publisher: string): boolean => {
    const manifest = role === 'owner' ? ownerManifest : hostManifest;
    return (
      (manifest !== null && revoked(manifest, publisher)) ||
      (input.heldRevocations?.[role] ?? []).some(value => domain(value) === publisher)
    );
  };
  const collectionLeg: SupplyPathLegs['owner_collection_declared'] = { ok: false };
  const declared = records(ownerManifest?.collections).filter(
    c =>
      (c.publisher_domain === undefined && !input.requireExplicitOwnerPublisherDomain) ||
      domain(c.publisher_domain) === owner
  );
  const targets = declared.filter(c => c.collection_id === input.collectionId && typeof c.collection_id === 'string');
  if (!ownerManifest) collectionLeg.failure = 'manifest_not_found';
  else if (owner && isRevoked('owner', owner)) collectionLeg.failure = 'publisher_revoked';
  else if (!input.collectionId && !declared.length) collectionLeg.failure = 'no_collections_declared';
  else if (!owner || !input.collectionId?.trim() || targets.length !== 1) {
    collectionLeg.failure = 'collection_not_declared';
    collectionLeg.detail = `owner declares ${declared.length} collection(s); none has an unambiguous collection_id "${input.collectionId}"`;
  } else {
    collectionLeg.ok = true;
    if (typeof targets[0]!.kind === 'string') collectionLeg.detail = `kind: ${targets[0]!.kind}`;
  }

  const carriage: SupplyPathLegs['owner_distribution_carriage'] = { ok: false };
  const entries = collectionLeg.ok
    ? records(targets[0]!.distribution).filter(e => domain(e.publisher_domain) === host)
    : [];
  let claimed: string[] = [];
  if (!collectionLeg.ok) carriage.failure = 'collection_leg_failed';
  else if (!host || !entries.length) carriage.failure = 'no_distribution_for_host';
  else {
    const valid = entries.every(
      e =>
        Object.keys(e).every(key => ['publisher_domain', 'property_ids', 'identifiers'].includes(key)) &&
        (e.property_ids === undefined || strings(e.property_ids)) &&
        (e.identifiers === undefined ||
          (Array.isArray(e.identifiers) &&
            e.identifiers.length > 0 &&
            e.identifiers.every(
              i =>
                record(i) &&
                typeof i.type === 'string' &&
                i.type.length > 0 &&
                typeof i.value === 'string' &&
                i.value.length > 0
            ))) &&
        (e.property_ids !== undefined || e.identifiers !== undefined)
    );
    claimed = [...new Set(entries.flatMap(e => (strings(e.property_ids) ? e.property_ids : [])))];
    if (!valid) {
      carriage.failure = 'property_ids_unresolved';
      carriage.detail = 'Malformed distribution constraints';
    } else if (!claimed.length) {
      carriage.ok = true;
      carriage.detail = 'carriage asserted without host property_ids (identifiers only)';
    } else if (!hostManifest) {
      carriage.failure = 'host_manifest_not_found';
      carriage.property_ids_unmatched = claimed;
    } else {
      const properties = records(hostManifest.properties).filter(
        p =>
          hasPropertyEnvelope(p) &&
          ((p.publisher_domain === undefined && !input.requireExplicitHostPublisherDomain) ||
            domain(p.publisher_domain) === host)
      );
      const counts = new Map<unknown, number>();
      for (const property of properties) counts.set(property.property_id, (counts.get(property.property_id) ?? 0) + 1);
      const known = new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
      carriage.property_ids_matched = claimed.filter(id => known.has(id));
      carriage.property_ids_unmatched = claimed.filter(id => !known.has(id));
      carriage.ok = carriage.property_ids_unmatched.length === 0;
      if (!carriage.ok) carriage.failure = 'property_ids_unresolved';
    }
  }
  const ownerAgent: SupplyPathLegs['owner_agent_declared'] = !ownerManifest
    ? { ok: false, failure: 'manifest_not_found' }
    : agent &&
        records(ownerManifest.authorized_agents).some(
          e =>
            agentIdentity(e.url) === agent &&
            owner &&
            hasPropertyAuthorizationEnvelope(e) &&
            (!input.requireExplicitOwnerPublisherDomain || e.collections !== undefined) &&
            coversCollection(e, owner, input.collectionId) &&
            !unsupportedConstraints(e).length
        )
      ? { ok: true }
      : { ok: false, failure: 'agent_not_declared_by_owner' };

  const hostLeg: SupplyPathLegs['host_authorization'] = { ok: false };
  if (!hostManifest) hostLeg.failure = 'manifest_not_found';
  else {
    const agents = agent ? records(hostManifest.authorized_agents).filter(e => agentIdentity(e.url) === agent) : [];
    const covered =
      owner && !isRevoked('host', owner) && !(host && isRevoked('owner', host))
        ? agents.filter(e => e.collections !== undefined && coversCollection(e, owner, input.collectionId))
        : [];
    if (!agents.length) hostLeg.failure = 'no_agent_entry';
    else if (!covered.length) hostLeg.failure = 'collection_scope_mismatch';
    else {
      const matched =
        host &&
        !isRevoked('host', host) &&
        carriage.ok &&
        collectionLeg.ok &&
        covered.find(e => {
          if (unsupportedConstraints(e).length) return false;
          if (!hasPropertyAuthorizationEnvelope(e)) return false;
          const scope = propertyScope(e, host, hostManifest, input.requireExplicitHostPublisherDomain);
          const required = input.requiredHostPropertyIds ?? claimed;
          if (
            input.requiredHostPropertyIds &&
            (!required.length || (claimed.length && !required.every(id => claimed.includes(id))))
          )
            return false;
          // With identifier-only owner carriage, the host must affirmatively
          // bind the collection to its own property scope.
          if (!claimed.length) return false;
          return required.length ? required.every(id => scope.has(id)) : scope.size > 0;
        });
      if (!matched) {
        const constraints = [...new Set(covered.flatMap(unsupportedConstraints))].sort();
        hostLeg.failure = covered.every(e => unsupportedConstraints(e).length)
          ? 'unsupported_constraints'
          : 'property_scope_mismatch';
        hostLeg.detail = constraints.length
          ? `Unevaluated grant fields: ${constraints.join(', ')}`
          : 'No grant proves the complete carried property scope';
      } else {
        hostLeg.ok = true;
        hostLeg.matched_entry = {
          url: String(matched.url),
          ...(typeof matched.authorization_type === 'string' ? { authorization_type: matched.authorization_type } : {}),
          ...(typeof matched.delegation_type === 'string' ? { delegation_type: matched.delegation_type } : {}),
          ...(Array.isArray(matched.collections)
            ? {
                collections: matched.collections.map(s => ({
                  publisher_domain: String(s.publisher_domain),
                  ...(s.collection_ids !== undefined ? { collection_ids: [...s.collection_ids] } : {}),
                })),
              }
            : {}),
        };
      }
    }
  }
  const partners = input.hostInventoryPartnerDomainsByFile
    ? inventoryPartnersForInput(input)
    : input.hostInventoryPartnerDomains;
  const partner: SupplyPathLegs['inventory_partner_domain'] =
    input.inventoryPartnerDomainEvaluated === false
      ? { ok: false, failure: 'not_evaluated' }
      : partners === null
        ? { ok: false, failure: 'ads_txt_unavailable' }
        : owner && partners.some(d => domain(d) === owner)
          ? { ok: true }
          : { ok: false, failure: 'not_declared' };
  const attested = collectionLeg.ok && entries.length > 0;
  const state =
    hostLeg.ok && collectionLeg.ok && carriage.ok
      ? 'verified_owner_sold'
      : partner.ok &&
          ownerAgent.ok &&
          collectionLeg.ok &&
          !((owner && isRevoked('host', owner)) || (host && isRevoked('host', host))) &&
          !(host && isRevoked('owner', host))
        ? 'host_delegated'
        : attested
          ? 'owner_attested'
          : 'unverified';
  return {
    semantics_version: '1',
    ...(collectionLeg.ok ? { resolved_collection_id: input.collectionId } : {}),
    state,
    legs: {
      owner_collection_declared: collectionLeg,
      owner_distribution_carriage: carriage,
      owner_agent_declared: ownerAgent,
      host_authorization: hostLeg,
      inventory_partner_domain: partner,
    },
  };
}

/** Choose applicable IAB files from the carried host properties, never from catalog channel identifiers. */
export function supplyPathAdsTxtPolicy(input: SupplyPathInput): {
  files: Array<'ads.txt' | 'app-ads.txt'>;
  requireAll: boolean;
} {
  if (input.collectionId === undefined) {
    const candidates = records(input.ownerManifest?.collections).filter(
      c => typeof c.collection_id === 'string' && c.collection_id.length > 0
    );
    if (candidates.length) {
      const policies = candidates.map(c => supplyPathAdsTxtPolicy({ ...input, collectionId: String(c.collection_id) }));
      return { files: [...new Set(policies.flatMap(policy => policy.files))].sort(), requireAll: false };
    }
  }
  const collectionIds = new Set(
    records(input.ownerManifest?.collections)
      .filter(c => input.collectionId === undefined || c.collection_id === input.collectionId)
      .flatMap(c =>
        records(c.distribution)
          .filter(d => domain(d.publisher_domain) === domain(input.hostDomain))
          .flatMap(d => (strings(d.property_ids) ? d.property_ids : []))
      )
  );
  const requested = input.requiredHostPropertyIds ? new Set(input.requiredHostPropertyIds) : collectionIds;
  const properties = records(input.hostManifest?.properties).filter(
    p =>
      hasPropertyEnvelope(p) &&
      requested.has(String(p.property_id)) &&
      ((p.publisher_domain === undefined && !input.requireExplicitHostPublisherDomain) ||
        domain(p.publisher_domain) === domain(input.hostDomain))
  );
  const files = new Set<'ads.txt' | 'app-ads.txt'>();
  for (const property of properties) {
    if (property.property_type === 'website') files.add('ads.txt');
    if (property.property_type === 'mobile_app' || property.property_type === 'ctv_app') files.add('app-ads.txt');
  }
  // Unknown surfaces have no applicable typed evidence. Without a host
  // manifest, the canonical interim path can only inspect domain-level files.
  if (!input.hostManifest || !properties.length) return { files: ['app-ads.txt', 'ads.txt'], requireAll: false };
  return { files: [...files].sort(), requireAll: true };
}

export function combineInventoryPartnerDomains(contents: Array<string | null>, requireAll: boolean): string[] | null {
  if (!contents.length || (requireAll && contents.some(c => c === null))) return null;
  const fetched = contents.filter((c): c is string => c !== null).map(parseInventoryPartnerDomains);
  if (!fetched.length) return null;
  return requireAll
    ? fetched[0]!.filter(d => fetched.every(domains => domains.includes(d)))
    : [...new Set(fetched.flat())];
}

/** Select parsed IAB evidence for one complete path; called after bulk inquiry expansion. */
export function inventoryPartnersForInput(input: SupplyPathInput): string[] | null {
  const policy = supplyPathAdsTxtPolicy(input);
  const values = policy.files.map(file => input.hostInventoryPartnerDomainsByFile?.[file] ?? null);
  if (!values.length || (policy.requireAll && values.some(value => value === null))) return null;
  const fetched = values.filter((value): value is string[] => value !== null);
  if (!fetched.length) return null;
  return policy.requireAll
    ? fetched[0]!.filter(domain => fetched.every(value => value.includes(domain)))
    : [...new Set(fetched.flat())];
}

export type { SupplyPathInput, SupplyPathLegs, SupplyPathManifest, SupplyPathVerdict } from './supply-path-contract.js';
