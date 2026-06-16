import { getClient } from './client.js';
import { uuidv7 } from './uuid.js';
import { CollectionCatalogDatabase, type CollectionProjectionEvent } from './collection-catalog-db.js';
import type { CatalogEventsDatabase, WriteEventInput } from './catalog-events-db.js';
import { normalizeIdentifier } from '../services/identifier-normalization.js';
import { canonicalizePublisherDomain } from '../services/publisher-domain.js';
import { createLogger } from '../logger.js';
import type { PoolClient } from 'pg';

const log = createLogger('publisher-db');

/**
 * Property as it appears inside an adagents.json file. The manifest body is
 * untrusted (publisher-controlled), so callers should pass already-validated
 * data — see AdAgentsManager.validateDomain. Fields here are loose because
 * downstream projection only needs identifiers + property_id.
 */
export interface AdagentsProperty {
  property_id?: string;
  property_type?: string;
  name?: string;
  identifiers?: Array<{ type?: string; value?: string }>;
  tags?: string[];
}

export interface AdagentsCollection {
  collection_id?: string;
  name?: string;
  kind?: string;
  distribution?: Array<{
    publisher_domain?: string;
    identifiers?: Array<{ type?: string; value?: string }>;
  }>;
  [key: string]: unknown;
}

/**
 * An authorized_agents[] entry from a publisher's adagents.json. Six
 * authorization_type variants exist per the spec; v1 of the catalog
 * projection covers the property-side cases (property_ids,
 * inline_properties, lexically-anchored publisher_properties).
 * property_tags / signal_ids / signal_tags are deferred — the legacy
 * agent_publisher_authorizations table continues to serve them via the
 * UNION reader during the dual-read window.
 */
export interface AdagentsAuthorizedAgent {
  url?: string;
  authorized_for?: string;
  authorization_type?:
    | 'property_ids'
    | 'property_tags'
    | 'inline_properties'
    | 'publisher_properties'
    | 'signal_ids'
    | 'signal_tags';
  property_ids?: string[];
  properties?: AdagentsProperty[];           // for inline_properties variant
  publisher_properties?: Array<{
    publisher_domain?: string;
    publisher_domains?: string[];
    selection_type?: 'all' | 'by_id' | 'by_tag';
    property_ids?: string[];
    property_tags?: string[];
  }>;
}

export interface AdagentsManifest {
  authorized_agents?: AdagentsAuthorizedAgent[];
  properties?: AdagentsProperty[];
  collections?: AdagentsCollection[];
  [key: string]: unknown;
}

export interface UpsertAdagentsCacheInput {
  domain: string;
  manifest: AdagentsManifest;
  expiresAt?: Date;
  /**
   * HTTP status code from the fetch that produced this manifest. When
   * supplied, written to publishers.last_http_status. Phase B of the
   * publisher-page redesign — surfaces verifier-grade chrome.
   */
  statusCode?: number;
  /**
   * Response body byte length (post-decompression). When
   * authoritative_location was followed, measures the canonical
   * document body, not the stub.
   */
  responseBytes?: number;
  /**
   * Final URL after following redirects + authoritative_location.
   * Differs from the publisher's expected /.well-known URL when
   * `self_redirected` or `aao_hosted`.
   */
  resolvedUrl?: string;
  /**
   * How the publisher's adagents.json was discovered. Mirrors
   * AdAgentsValidationResult.discovery_method. Written to
   * publishers.discovery_method so the API can surface provenance.
   */
  discoveryMethod?: string;
  /**
   * When discoveryMethod is 'ads_txt_managerdomain', the manager domain
   * whose adagents.json was used. Written to publishers.manager_domain.
   */
  managerDomain?: string;
  eventsDb?: CatalogEventsDatabase;
  collectionEventActor?: string;
}

export interface RecordAdagentsValidationFailureInput {
  domain: string;
  statusCode?: number;
  responseBytes?: number;
  resolvedUrl?: string;
  error?: string;
  issues?: unknown;
}

export interface UpsertAdagentsCacheResult {
  collectionEvents: CollectionProjectionEvent[];
}

export interface UpsertCommunityAdagentsCatalogInput {
  platform: string;
  manifest: AdagentsManifest;
  previousManifest?: AdagentsManifest | Record<string, unknown> | null;
  catalogUrl?: string;
  createdByUserId?: string | null;
  createdByEmail?: string | null;
  eventsDb?: CatalogEventsDatabase;
}

const ADAGENTS_CREATED_BY_PREFIX = 'adagents_json:';
const COMMUNITY_CATALOG_CREATED_BY_PREFIX = 'community_adagents:';

interface CommunityCatalogPropertyKey {
  publisherDomain: string;
  propertyId: string | null;
  name: string;
  propertyType: string;
}

function adagentsCreatedBy(publisherDomain: string): string {
  return `${ADAGENTS_CREATED_BY_PREFIX}${publisherDomain}`;
}

function communityCatalogCreatedBy(platform: string): string {
  return `${COMMUNITY_CATALOG_CREATED_BY_PREFIX}${platform}`;
}

/**
 * Whether a domain/subdomain identifier lexically belongs to the publisher.
 *
 * Bundle IDs, RSS URLs, and other non-domain identifier types have no
 * lexical relationship to the publisher's hostname, so they are never
 * anchors. This is what stops a manifest hosted at attacker.example from
 * legitimately claiming `domain:victim.example` — the anchor check rejects
 * the cross-publisher domain claim before it can land in the catalog.
 */
function isPublisherDomainAnchor(publisherDomain: string, type: string, value: string): boolean {
  if (type !== 'domain' && type !== 'subdomain') return false;
  if (value === publisherDomain) return true;
  return value.endsWith(`.${publisherDomain}`);
}

/**
 * Canonicalize an agent_url to match the schema's invariant
 * (lowercase, no trailing slash, wildcard '*' is the sentinel).
 * Returns null when the input is not a usable URL — callers skip those
 * rows rather than fail the whole projection.
 *
 * Exported so the agent-side sync endpoints
 * (server/src/db/authorization-snapshot-db.ts) canonicalize the
 * agent_url query parameter through the same function the writer uses
 * for stored rows. Drift between the two would silently miss matches.
 */
// Phase B fetch-metadata hardening. The HTTP status writer column is a
// SMALLINT (-32768..32767), broader than the RFC 100..599 range. Clamp
// at write time so a malicious origin returning, e.g., status 999 can't
// surface that to verifiers — text-only display is harmless, but the
// schema docstring promises 100..599 and we should match it.
function clampHttpStatus(status: number | undefined): number | null {
  if (typeof status !== 'number' || !Number.isFinite(status)) return null;
  return Math.max(100, Math.min(599, Math.trunc(status)));
}

// Phase B: cap resolved_url length at write. `Response.url` is built
// from chained Location headers — undici defaults bound each hop but
// not the resulting string. A pathological redirect chain could
// otherwise stuff a multi-KB URL into the column. 2048 covers every
// real publisher CDN URL with comfortable headroom.
const RESOLVED_URL_MAX = 2048;
function truncateResolvedUrl(url: string | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  return url.length > RESOLVED_URL_MAX ? url.slice(0, RESOLVED_URL_MAX) : url;
}

// Pattern from the JSON Schema for `publisher_domain`. Used after
// canonicalization to drop entries whose canonical form doesn't look like
// a publishable domain — embedded control chars, scheme remnants, paths,
// etc. would otherwise land in the revocation set with a key that no
// real lookup hits (silently-ignored revocation), which is the wrong
// failure mode for a security control.
const PUBLISHER_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function collectionProjectionEventPayload(event: CollectionProjectionEvent): Record<string, unknown> {
  return {
    collection_rid: event.collection_rid,
    publisher_domain: event.publisher_domain,
    collection_id: event.collection_id,
    name: event.name,
    kind: event.kind,
    source: event.source,
    status: event.status,
    identifiers: event.identifiers,
    collection: event.collection,
  };
}

function collectionProjectionWriteEvents(
  events: CollectionProjectionEvent[],
  actor: string,
): WriteEventInput[] {
  return events.map((event) => ({
    event_type: event.event_type,
    entity_type: 'collection',
    entity_id: event.collection_rid,
    payload: collectionProjectionEventPayload(event),
    actor,
  }));
}

// Read `revoked_publisher_domains[]` from a (loose-typed) manifest and return
// the set of canonicalized publisher_domain values. Entries MUST carry both
// a string `publisher_domain` (which canonicalizes to a schema-valid domain)
// and a parseable `revoked_at` per the spec — the writer is a security
// boundary, and silently accepting malformed revocation entries is the
// same shape as the cross-publisher bypass this PR closes. Malformed
// entries are dropped, not honored.
function extractRevokedPublisherDomains(manifest: unknown): Set<string> {
  const out = new Set<string>();
  const m = manifest as { revoked_publisher_domains?: unknown };
  if (!Array.isArray(m?.revoked_publisher_domains)) return out;
  for (const entry of m.revoked_publisher_domains) {
    const pd = (entry as { publisher_domain?: unknown })?.publisher_domain;
    const ra = (entry as { revoked_at?: unknown })?.revoked_at;
    if (typeof pd !== 'string' || pd.length === 0) continue;
    if (typeof ra !== 'string' || ra.length === 0) continue;
    // Require parseable date-time. Date.parse returns NaN on invalid input.
    if (Number.isNaN(Date.parse(ra))) continue;
    const canonical = canonicalizePublisherDomain(pd);
    // Reject canonical forms that wouldn't pass the schema pattern — they
    // can't match any legitimately-stored publisher_domain anyway, and
    // accepting them lets a misbehaving manifest hide revocations as
    // garbage entries.
    if (!PUBLISHER_DOMAIN_PATTERN.test(canonical)) continue;
    out.add(canonical);
  }
  return out;
}

export function canonicalizeAgentUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === '*') return '*';
  // Reject embedded wildcards — the schema CHECK in migration 440 only
  // accepts '*' as exact-match. Anything else (e.g. *foo*) would fail
  // the CHECK and abort the whole transaction.
  if (trimmed.includes('*')) return null;
  // Reject internal whitespace and control chars. A URL with embedded
  // newlines or tabs would land in the canonical form and become
  // unmatchable by lookup callers. URL.parse() at the validator level
  // doesn't enforce this hard.
  if (/[\s\x00-\x1f]/.test(trimmed)) return null;
  let canonical = trimmed.toLowerCase();
  while (canonical.endsWith('/')) canonical = canonical.slice(0, -1);
  if (canonical.length === 0) return null;
  return canonical;
}

/**
 * Database operations for the publisher overlay (migration 432).
 *
 * Caches the source-of-truth adagents.json file body and projects the parsed
 * manifest into the property catalog (catalog_properties + catalog_identifiers).
 * The cache write and the per-property projections share one transaction;
 * each property is wrapped in a savepoint so a constraint violation on one
 * malformed property does not lose the rest of the manifest.
 */
export class PublisherDatabase {
  private readonly collectionCatalog = new CollectionCatalogDatabase();

  /**
   * Cache an adagents.json manifest and project its properties into the
   * catalog.
   *
   * ON CONFLICT for the publishers row only touches the manifest body and the
   * crawl-tracking columns; org/ownership and review state are preserved so a
   * later org claim isn't wiped by a routine re-crawl.
   */
  /**
   * Record a failed adagents.json fetch attempt. The crawl returned a
   * non-200 response (404, 5xx, etc.) so there is no manifest to cache,
   * but the fetch metadata still belongs on the publishers row so the
   * verifier-facing UI can show "Last attempted: <ts> · HTTP <code>".
   * Does not touch adagents_json (preserves the last successful body
   * if one exists) and does not bump source_type.
   */
  /**
   * Record a child publisher synthesized from a manager file's
   * publisher_properties[].publisher_domains[] fan-out (adcp#4825 inline
   * resolution). The child has not been independently crawled — the
   * manager file IS the authorization. Stamp discovery_method
   * 'adagents_authoritative' and manager_domain on the publishers row
   * without writing adagents_json (we never fetched the child's origin).
   *
   * If a stronger row already exists (the child WAS independently
   * crawled and has adagents_json cached), don't overwrite its
   * provenance — direct crawl wins over manager-file attribution.
   */
  async recordChildPublisherFromManager(input: {
    childDomain: string;
    managerDomain: string;
  }): Promise<void> {
    const childDomain = canonicalizePublisherDomain(input.childDomain);
    const managerDomain = canonicalizePublisherDomain(input.managerDomain);
    if (childDomain === managerDomain) return; // never self-attribute
    const client = await getClient();
    try {
      await client.query(
        `INSERT INTO publishers
           (domain, source_type, discovery_method, manager_domain, last_validated)
         VALUES ($1, 'community', 'adagents_authoritative', $2, NOW())
         ON CONFLICT (domain) DO UPDATE SET
           discovery_method = CASE
             WHEN publishers.adagents_json IS NULL THEN EXCLUDED.discovery_method
             ELSE publishers.discovery_method
           END,
           manager_domain = CASE
             WHEN publishers.adagents_json IS NULL THEN EXCLUDED.manager_domain
             ELSE publishers.manager_domain
           END,
           last_validated = CASE
             WHEN publishers.adagents_json IS NULL THEN NOW()
             ELSE publishers.last_validated
           END,
           updated_at = NOW()`,
        [childDomain, managerDomain],
      );

      // Enqueue the child for delayed periodic re-validation (#4850) so a
      // manager-asserted child eventually gets bilateral confirmation
      // (or a 404 backoff). Initial delay of 24h prevents 6,800 fan-out
      // children from immediately storming the crawler — they spread
      // across the next day's drain ticks. ON CONFLICT DO NOTHING
      // preserves any existing backoff window (avoid resetting if the
      // child already 404'd recently).
      await client.query(
        `INSERT INTO manager_revalidation_queue
           (publisher_domain, manager_domain, enqueued_at, next_attempt_after, attempts, last_attempted_at, last_error)
         VALUES ($1, $2, NOW(), NOW() + INTERVAL '24 hours', 0, NULL, NULL)
         ON CONFLICT (publisher_domain) DO NOTHING`,
        [childDomain, managerDomain],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Project a fan-out authorization edge into the catalog
   * (`catalog_agent_authorizations`) so the partner-sync endpoints
   * (`/registry/authorizations`, `/registry/authorizations/snapshot`)
   * — which read the catalog only — see the same edge the legacy
   * `agent_publisher_authorizations` arm carries. Adcp#4841.
   *
   * The catalog's `cacheAdagentsManifest` projection deliberately
   * refuses cross-publisher claims (publisher-db.ts ~L968: a manager
   * file cannot land authoritative rows for another publisher's
   * properties without out-of-band corroboration). For the fan-out
   * shape — where the manager file names the child publisher in its
   * `publisher_properties[].publisher_domains[]` selector — the
   * out-of-band corroboration is the inline-resolution rule itself
   * (#4825). Evidence value `'adagents_authoritative'` (migration 488)
   * carries the lower trust profile so consumers can filter when
   * bilateral verification matters.
   *
   * Called from the crawler's fan-out helper per (agent, child) pair.
   * The companion `recordChildPublisherFromManager` writes the
   * publishers row (per-child, agent-independent); this writes the
   * catalog row (per agent × child).
   */
  async recordCatalogFanoutAuthorization(input: {
    agentUrl: string;
    childDomain: string;
    authorizedFor?: string;
  }): Promise<void> {
    const childDomain = canonicalizePublisherDomain(input.childDomain);
    const agentCanonical = canonicalizeAgentUrl(input.agentUrl);
    if (!agentCanonical) return; // canonicalizer rejected — invalid URL, skip
    const client = await getClient();
    try {
      await client.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, property_rid, property_id_slug,
            publisher_domain, authorized_for, evidence, created_by)
         VALUES ($1, $2, NULL, NULL, $3, $4, 'adagents_authoritative', 'system')
         ON CONFLICT (agent_url_canonical,
                      (COALESCE(property_rid::text, '')),
                      (COALESCE(publisher_domain, '')),
                      evidence)
                WHERE deleted_at IS NULL
         DO UPDATE SET
           authorized_for = EXCLUDED.authorized_for,
           updated_at = NOW()`,
        [input.agentUrl, agentCanonical, childDomain, input.authorizedFor ?? null],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Project an approved community catalog-only adagents.json into the normal
   * publisher registry read model. This is the compatibility bridge that keeps
   * the legacy "community mirror" storage table from becoming a separate public
   * concept: each property.publisher_domain gets its own community-sourced
   * publishers row and property records.
   */
  async upsertCommunityAdagentsCatalog(input: UpsertCommunityAdagentsCatalogInput): Promise<string[]> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const updatedDomains = await this.replaceCommunityAdagentsCatalogWithClient(client, input);
      await client.query('COMMIT');
      return updatedDomains;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async replaceCommunityAdagentsCatalogWithClient(
    client: PoolClient,
    input: UpsertCommunityAdagentsCatalogInput,
  ): Promise<string[]> {
    const platform = input.platform.toLowerCase();
    const properties = Array.isArray(input.manifest.properties) ? input.manifest.properties : [];
    const collections = Array.isArray(input.manifest.collections) ? input.manifest.collections : [];
    const byDomain = new Map<string, AdagentsProperty[]>();
    const collectionsByDomain = new Map<string, AdagentsCollection[]>();

    for (const property of properties) {
      const domain = this.readCommunityCatalogPublisherDomain(property);
      if (!domain) continue;
      const bucket = byDomain.get(domain) ?? [];
      bucket.push(property);
      byDomain.set(domain, bucket);
    }

    for (const collection of collections) {
      const domain = this.readCommunityCatalogCollectionPublisherDomain(collection);
      if (!domain) continue;
      const bucket = collectionsByDomain.get(domain) ?? [];
      bucket.push(collection);
      collectionsByDomain.set(domain, bucket);
    }

    const updatedDomains: string[] = [];
    await this.retireCommunityAdagentsCatalogWithClient(client, platform, input.previousManifest, {
      includeCollections: false,
    });

    const communityCollectionEvents: CollectionProjectionEvent[] = [];
    const previousCollections = Array.isArray(input.previousManifest?.collections)
      ? input.previousManifest.collections as AdagentsCollection[]
      : [];
    const collectionDomains = new Set([...collectionsByDomain.keys()]);
    for (const collection of previousCollections) {
      const domain = this.readCommunityCatalogCollectionPublisherDomain(collection);
      if (domain) collectionDomains.add(domain);
    }
    for (const domain of collectionDomains) {
      const activeCollectionIds = (collectionsByDomain.get(domain) ?? [])
        .map((collection) => collection.collection_id)
        .filter((collectionId): collectionId is string =>
          typeof collectionId === 'string' && collectionId.trim().length > 0
        )
        .map((collectionId) => collectionId.trim());
      communityCollectionEvents.push(
        ...await this.collectionCatalog.retireMissingAdagentsCollections(
          client,
          domain,
          activeCollectionIds,
          communityCatalogCreatedBy(platform),
          'community',
        ),
      );
    }

    const domains = new Set([...byDomain.keys(), ...collectionsByDomain.keys()]);
    for (const domain of domains) {
      const domainProperties = byDomain.get(domain) ?? [];
      const domainCollections = collectionsByDomain.get(domain) ?? [];
      const scopedManifest: AdagentsManifest = {
        ...input.manifest,
        properties: domainProperties,
        collections: domainCollections,
        authorized_agents: Array.isArray(input.manifest.authorized_agents)
          ? input.manifest.authorized_agents
          : [],
      };

      const publisherWrite = await client.query<{ source_type: string }>(
        `INSERT INTO publishers
           (domain, adagents_json, source_type, review_status, is_public,
            last_validated, resolved_url, discovery_method,
            created_by_user_id, created_by_email)
         VALUES ($1, $2::jsonb, 'community', 'approved', TRUE,
                 NULL, $3, 'community_catalog', $4, $5)
           ON CONFLICT (domain) DO UPDATE SET
             adagents_json = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.adagents_json
               ELSE EXCLUDED.adagents_json
             END,
             source_type = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.source_type
               ELSE 'community'
             END,
             review_status = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.review_status
               ELSE 'approved'
             END,
             is_public = TRUE,
             last_validated = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.last_validated
               ELSE NULL
             END,
             resolved_url = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.resolved_url
               ELSE EXCLUDED.resolved_url
             END,
             discovery_method = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.discovery_method
               ELSE 'community_catalog'
             END,
             created_by_user_id = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.created_by_user_id
               ELSE EXCLUDED.created_by_user_id
             END,
             created_by_email = CASE
               WHEN publishers.source_type = 'adagents_json' THEN publishers.created_by_email
               ELSE EXCLUDED.created_by_email
             END,
             updated_at = NOW()
         RETURNING source_type`,
        [
          domain,
          JSON.stringify(scopedManifest),
          input.catalogUrl ?? null,
          communityCatalogCreatedBy(platform),
          input.createdByEmail ?? null,
        ],
      );

      if (publisherWrite.rows[0]?.source_type === 'adagents_json') {
        communityCollectionEvents.push(
          ...await this.collectionCatalog.retireMissingAdagentsCollections(
            client,
            domain,
            [],
            communityCatalogCreatedBy(platform),
            'community',
          ),
        );
        updatedDomains.push(domain);
        continue;
      }

      for (const property of domainProperties) {
        await this.upsertCommunityCatalogProperty(client, platform, domain, property, input.catalogUrl);
      }
      for (const collection of domainCollections) {
        const event = await this.collectionCatalog.projectCollection(client, {
          publisherDomain: domain,
          collection: collection as Record<string, unknown>,
          evidence: 'community',
          confidence: 'strong',
          source: 'contributed',
          adagentsUrl: input.catalogUrl ?? null,
          createdBy: communityCatalogCreatedBy(platform),
        });
        if (event) communityCollectionEvents.push(event);
      }
      updatedDomains.push(domain);
    }

    if (input.eventsDb && communityCollectionEvents.length > 0) {
      await input.eventsDb.writeEvents(
        collectionProjectionWriteEvents(communityCollectionEvents, 'registry:community_mirror'),
        client,
      );
    }

    return updatedDomains;
  }

  async retireCommunityAdagentsCatalog(
    platform: string,
    manifest?: AdagentsManifest | Record<string, unknown> | null,
  ): Promise<void> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await this.retireCommunityAdagentsCatalogWithClient(client, platform, manifest);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async retireCommunityAdagentsCatalogWithClient(
    client: PoolClient,
    platform: string,
    manifest?: AdagentsManifest | Record<string, unknown> | null,
    options: { includeCollections?: boolean } = {},
  ): Promise<void> {
    const createdBy = communityCatalogCreatedBy(platform.toLowerCase());
    const includeCollections = options.includeCollections ?? true;
    await client.query(
      `DELETE FROM catalog_identifiers ci
        WHERE ci.property_rid IN (
          SELECT cp.property_rid
            FROM catalog_properties cp
           WHERE cp.created_by = $1
        )`,
      [createdBy],
    );
    if (includeCollections) {
      await client.query(
        `DELETE FROM catalog_collection_identifiers cci
          WHERE cci.collection_rid IN (
            SELECT cc.collection_rid
              FROM catalog_collections cc
             WHERE cc.created_by = $1
          )`,
        [createdBy],
      );
      await client.query(
        `DELETE FROM catalog_collections
          WHERE created_by = $1`,
        [createdBy],
      );
    }
    await client.query(
      `DELETE FROM catalog_properties
        WHERE created_by = $1`,
      [createdBy],
    );
    const manifestKeys = this.readCommunityCatalogPropertyKeys(manifest);
    if (manifestKeys.length > 0) {
      await this.deleteCommunityDiscoveredPropertiesForKeys(client, manifestKeys);
    } else {
      await client.query(
        `DELETE FROM discovered_properties dp
          WHERE dp.source_type = 'community'
            AND EXISTS (
              SELECT 1
                FROM publishers p
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(p.adagents_json->'properties') = 'array'
                       THEN p.adagents_json->'properties'
                       ELSE '[]'::jsonb END
                ) AS prop
               WHERE p.source_type = 'community'
                 AND p.discovery_method = 'community_catalog'
                 AND p.created_by_user_id = $1
                 AND p.domain = dp.publisher_domain
                 AND (
                   (prop->>'property_id' IS NOT NULL AND prop->>'property_id' = dp.property_id)
                   OR (
                     prop->>'property_id' IS NULL
                     AND prop->>'name' = dp.name
                     AND prop->>'property_type' = dp.property_type
                   )
                 )
            )`,
        [createdBy],
      );
    }
    await client.query(
      `DELETE FROM publishers
        WHERE source_type = 'community'
          AND discovery_method = 'community_catalog'
          AND created_by_user_id = $1`,
      [createdBy],
    );
  }

  private readCommunityCatalogPublisherDomain(property: AdagentsProperty): string | null {
    const explicit = (property as AdagentsProperty & { publisher_domain?: unknown }).publisher_domain;
    if (typeof explicit === 'string' && explicit.trim()) {
      return canonicalizePublisherDomain(explicit);
    }

    const identifiers = Array.isArray(property.identifiers) ? property.identifiers : [];
    const domainIdentifier = identifiers.find((i) =>
      (i?.type === 'domain' || i?.type === 'subdomain')
      && typeof i.value === 'string'
      && i.value.trim().length > 0
    );
    return domainIdentifier?.value ? canonicalizePublisherDomain(domainIdentifier.value) : null;
  }

  private readCommunityCatalogCollectionPublisherDomain(collection: AdagentsCollection): string | null {
    const explicit = (collection as AdagentsCollection & { publisher_domain?: unknown }).publisher_domain;
    if (typeof explicit === 'string' && explicit.trim()) {
      return canonicalizePublisherDomain(explicit);
    }

    const distribution = Array.isArray(collection.distribution) ? collection.distribution : [];
    for (const entry of distribution) {
      if (!entry || typeof entry !== 'object') continue;
      const domainIdentifier = entry.identifiers?.find((i) =>
        i?.type === 'domain'
        && typeof i.value === 'string'
        && i.value.trim().length > 0
      );
      if (domainIdentifier?.value) return canonicalizePublisherDomain(domainIdentifier.value);
    }
    return null;
  }

  private readCommunityCatalogPropertyKeys(
    manifest?: AdagentsManifest | Record<string, unknown> | null,
  ): CommunityCatalogPropertyKey[] {
    const properties = Array.isArray(manifest?.properties) ? manifest.properties : [];
    const keys: CommunityCatalogPropertyKey[] = [];
    for (const property of properties as AdagentsProperty[]) {
      const publisherDomain = this.readCommunityCatalogPublisherDomain(property);
      if (!publisherDomain) continue;
      const propertyType = typeof property.property_type === 'string' && property.property_type
        ? property.property_type
        : 'website';
      const name = typeof property.name === 'string' && property.name
        ? property.name
        : property.property_id ?? publisherDomain;
      keys.push({
        publisherDomain,
        propertyId: typeof property.property_id === 'string' && property.property_id ? property.property_id : null,
        name,
        propertyType,
      });
    }
    return keys;
  }

  private async deleteCommunityDiscoveredPropertiesForKeys(
    client: PoolClient,
    keys: CommunityCatalogPropertyKey[],
  ): Promise<void> {
    if (keys.length === 0) return;
    const conditions: string[] = [];
    const params: unknown[] = [];
    for (const key of keys) {
      if (key.propertyId) {
        params.push(key.publisherDomain, key.propertyId);
        conditions.push(`(publisher_domain = $${params.length - 1} AND property_id = $${params.length})`);
      } else {
        params.push(key.publisherDomain, key.name, key.propertyType);
        conditions.push(`(publisher_domain = $${params.length - 2} AND name = $${params.length - 1} AND property_type = $${params.length})`);
      }
    }
    await client.query(
      `DELETE FROM discovered_properties
        WHERE source_type = 'community'
          AND (${conditions.join(' OR ')})`,
      params,
    );
  }

  private async upsertCommunityCatalogProperty(
    client: PoolClient,
    platform: string,
    publisherDomain: string,
    property: AdagentsProperty,
    catalogUrl?: string,
  ): Promise<void> {
    const propertyType = typeof property.property_type === 'string' && property.property_type
      ? property.property_type
      : 'website';
    const name = typeof property.name === 'string' && property.name
      ? property.name
      : property.property_id ?? publisherDomain;
    const identifiers = Array.isArray(property.identifiers) ? property.identifiers : [];
    const tags = Array.isArray(property.tags)
      ? property.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const propertyId = typeof property.property_id === 'string' && property.property_id.length > 0
      ? property.property_id
      : null;
    let updatedByPropertyId = false;

    if (propertyId) {
      const byPropertyId = await client.query(
        `UPDATE discovered_properties
            SET identifiers = CASE
                  WHEN source_type IN ('adagents_json', 'aao_hosted') THEN identifiers
                  ELSE $3::jsonb
                END,
                tags = CASE
                  WHEN source_type IN ('adagents_json', 'aao_hosted') THEN tags
                  ELSE $4
                END,
                source_type = CASE
                  WHEN source_type IN ('adagents_json', 'aao_hosted') THEN source_type
                  ELSE 'community'
                END,
                last_validated = CASE
                  WHEN source_type IN ('adagents_json', 'aao_hosted') THEN last_validated
                  ELSE NOW()
                END
          WHERE publisher_domain = $1
            AND property_id = $2`,
        [
          publisherDomain,
          propertyId,
          JSON.stringify(identifiers),
          tags,
        ],
      );
      updatedByPropertyId = (byPropertyId.rowCount ?? 0) > 0;
    }

    if (!updatedByPropertyId) {
      await client.query(
        `INSERT INTO discovered_properties (
           property_id, publisher_domain, property_type, name,
           identifiers, tags, source_type, last_validated
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'community', NOW())
         ON CONFLICT (publisher_domain, name, property_type) DO UPDATE SET
           property_id = CASE
             WHEN discovered_properties.source_type IN ('adagents_json', 'aao_hosted') THEN discovered_properties.property_id
             ELSE COALESCE(EXCLUDED.property_id, discovered_properties.property_id)
           END,
           identifiers = CASE
             WHEN discovered_properties.source_type IN ('adagents_json', 'aao_hosted') THEN discovered_properties.identifiers
             ELSE EXCLUDED.identifiers
           END,
           tags = CASE
             WHEN discovered_properties.source_type IN ('adagents_json', 'aao_hosted') THEN discovered_properties.tags
             ELSE EXCLUDED.tags
           END,
           source_type = CASE
             WHEN discovered_properties.source_type IN ('adagents_json', 'aao_hosted') THEN discovered_properties.source_type
             ELSE 'community'
           END,
           last_validated = CASE
             WHEN discovered_properties.source_type IN ('adagents_json', 'aao_hosted') THEN discovered_properties.last_validated
             ELSE NOW()
           END`,
        [
          propertyId,
          publisherDomain,
          propertyType,
          name,
          JSON.stringify(identifiers),
          tags,
        ],
      );
    }

    const rawIdentifiers = identifiers
      .filter((i): i is { type: string; value: string } =>
        typeof i?.type === 'string' && typeof i?.value === 'string' && i.type.length > 0 && i.value.length > 0
      )
      .map((i) => {
        const norm = normalizeIdentifier(i.type, i.value);
        return { type: norm.type, value: norm.value.toLowerCase() };
      });
    if (rawIdentifiers.length === 0) return;

    const propertyRid = uuidv7();
    await client.query(
      `INSERT INTO catalog_properties
         (property_rid, property_id, classification, source, status, adagents_url, created_by)
       VALUES ($1, $2, 'property', 'contributed', 'active', $3, $4)`,
      [
        propertyRid,
        property.property_id ?? null,
        catalogUrl ?? null,
        communityCatalogCreatedBy(platform),
      ],
    );

    for (const ident of rawIdentifiers) {
      await client.query(
        `INSERT INTO catalog_identifiers
           (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES ($1, $2, $3, $4, 'community', 'strong')
         ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
        [uuidv7(), propertyRid, ident.type, ident.value],
      );
    }
  }

  async recordFailedAdagentsFetch(input: {
    domain: string;
    statusCode?: number;
    responseBytes?: number;
    resolvedUrl?: string;
  }): Promise<void> {
    const domain = canonicalizePublisherDomain(input.domain);
    const client = await getClient();
    try {
      await client.query(
        `INSERT INTO publishers
           (domain, source_type, last_http_status, last_response_bytes, resolved_url)
         VALUES ($1, 'community', $2, $3, $4)
         ON CONFLICT (domain) DO UPDATE SET
           last_http_status = EXCLUDED.last_http_status,
           last_response_bytes = EXCLUDED.last_response_bytes,
           resolved_url = EXCLUDED.resolved_url,
           updated_at = NOW()`,
        [
          domain,
          clampHttpStatus(input.statusCode),
          input.responseBytes ?? null,
          truncateResolvedUrl(input.resolvedUrl),
        ],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Persist an operator-triggered failed validation verdict. Unlike the
   * routine failed-fetch path, this clears a stale publisher-origin cache and
   * retires adagents_json authorizations because a human explicitly asked the
   * registry to re-check the live source of truth now.
   */
  async recordAdagentsValidationFailure(input: RecordAdagentsValidationFailureInput): Promise<void> {
    const domain = canonicalizePublisherDomain(input.domain);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO publishers
           (domain, source_type, adagents_json, last_http_status, last_response_bytes,
            resolved_url, discovery_method, manager_domain, last_validation_error,
            last_validation_issues)
         VALUES ($1, 'community', NULL, $2, $3, $4, NULL, NULL, $5, $6::jsonb)
         ON CONFLICT (domain) DO UPDATE SET
           adagents_json = CASE
             WHEN publishers.source_type = 'adagents_json' THEN NULL
             ELSE publishers.adagents_json
           END,
           source_type = CASE
             WHEN publishers.source_type = 'adagents_json' THEN 'community'
             ELSE publishers.source_type
           END,
           last_http_status = EXCLUDED.last_http_status,
           last_response_bytes = EXCLUDED.last_response_bytes,
           resolved_url = EXCLUDED.resolved_url,
           discovery_method = CASE
             WHEN publishers.source_type = 'adagents_json' THEN NULL
             ELSE publishers.discovery_method
           END,
           manager_domain = CASE
             WHEN publishers.source_type = 'adagents_json' THEN NULL
             ELSE publishers.manager_domain
           END,
           last_validation_error = EXCLUDED.last_validation_error,
           last_validation_issues = EXCLUDED.last_validation_issues,
           updated_at = NOW()`,
        [
          domain,
          clampHttpStatus(input.statusCode),
          input.responseBytes ?? null,
          truncateResolvedUrl(input.resolvedUrl),
          input.error ?? null,
          input.issues === undefined ? null : JSON.stringify(input.issues),
        ],
      );

      await client.query(
        `UPDATE catalog_agent_authorizations caa
            SET deleted_at = NOW()
          WHERE caa.evidence = 'adagents_json'
            AND caa.created_by = 'system'
            AND caa.deleted_at IS NULL
            AND (
              caa.publisher_domain = $1
              OR caa.property_rid IN (
                SELECT property_rid FROM catalog_properties WHERE created_by = $2
              )
              OR (caa.property_id_slug IS NOT NULL AND caa.property_rid IN (
                SELECT property_rid FROM catalog_properties WHERE created_by = $2
              ))
            )`,
        [domain, adagentsCreatedBy(domain)],
      );

      await client.query(
        `UPDATE discovered_publishers
            SET has_valid_adagents = FALSE,
                last_validated = NOW()
          WHERE domain = $1`,
        [domain],
      );

      await client.query(
        `DELETE FROM agent_publisher_authorizations
          WHERE publisher_domain = $1
            AND source = 'adagents_json'`,
        [domain],
      );

      await client.query(
        `DELETE FROM agent_property_authorizations apa
          USING discovered_properties dp
         WHERE apa.property_id = dp.id
           AND dp.publisher_domain = $1
           AND dp.source_type = 'adagents_json'`,
        [domain],
      );

      await client.query(
        `DELETE FROM discovered_properties
          WHERE publisher_domain = $1
            AND source_type = 'adagents_json'`,
        [domain],
      );

      await client.query(
        `DELETE FROM catalog_identifiers ci
          USING catalog_properties cp
         WHERE ci.property_rid = cp.property_rid
           AND cp.created_by = $1`,
        [adagentsCreatedBy(domain)],
      );

      await client.query(
        `DELETE FROM catalog_properties WHERE created_by = $1`,
        [adagentsCreatedBy(domain)],
      );

      await this.collectionCatalog.retireMissingAdagentsCollections(
        client,
        domain,
        [],
        adagentsCreatedBy(domain),
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertAdagentsCache(input: UpsertAdagentsCacheInput): Promise<UpsertAdagentsCacheResult> {
    const domain = canonicalizePublisherDomain(input.domain);
    const client = await getClient();
    const collectionEvents: CollectionProjectionEvent[] = [];
    try {
      await client.query('BEGIN');

      // Normalize array fields before caching. The validator only enforces
      // `authorized_agents` shape, so a publisher serving a JSON-valid file
      // with `properties: "x"` could otherwise land non-array JSONB that
      // breaks downstream readers (jsonb_array_elements / jsonb_array_length
      // error on non-arrays). Belt-and-suspenders for the SQL-side guards.
      const safeManifest: AdagentsManifest = {
        ...input.manifest,
        properties: Array.isArray(input.manifest.properties) ? input.manifest.properties : [],
        collections: Array.isArray(input.manifest.collections) ? input.manifest.collections : [],
        authorized_agents: Array.isArray(input.manifest.authorized_agents)
          ? input.manifest.authorized_agents
          : [],
      };

      await client.query(
        `INSERT INTO publishers
           (domain, adagents_json, source_type, last_validated, expires_at,
            last_http_status, last_response_bytes, resolved_url,
            discovery_method, manager_domain)
         VALUES ($1, $2::jsonb, 'adagents_json', NOW(), $3, $4, $5, $6, $7, $8)
         ON CONFLICT (domain) DO UPDATE SET
           adagents_json = EXCLUDED.adagents_json,
           source_type = 'adagents_json',
           last_validated = NOW(),
           expires_at = EXCLUDED.expires_at,
           last_http_status = EXCLUDED.last_http_status,
           last_response_bytes = EXCLUDED.last_response_bytes,
           resolved_url = EXCLUDED.resolved_url,
           discovery_method = EXCLUDED.discovery_method,
           manager_domain = EXCLUDED.manager_domain,
           last_validation_error = NULL,
           last_validation_issues = NULL,
           updated_at = NOW()`,
        [
          domain,
          JSON.stringify(safeManifest),
          input.expiresAt ?? null,
          clampHttpStatus(input.statusCode),
          input.responseBytes ?? null,
          truncateResolvedUrl(input.resolvedUrl),
          input.discoveryMethod ?? null,
          input.managerDomain ?? null,
        ]
      );

      // `revoked_publisher_domains[]` precedence: if this manifest revokes
      // the source domain, skip property and authorization projection
      // entirely AND retire any catalog rows that a prior projection of
      // this same publisher had landed. The publishers row stays as the
      // verbatim cache of the manifest, but every writer-owned catalog
      // row (`evidence='adagents_json'`, `created_by='system'`) gets
      // soft-deleted so the index stops authorizing the revoked
      // publisher on the next refresh. Without this retirement the
      // revocation is advisory only — stale rows from before the
      // revocation would continue to serve, defeating the security gate
      // the spec promises. See managed-networks.mdx (Publisher
      // revocation) and the reconciliation block below this branch.
      const revokedDomains = extractRevokedPublisherDomains(safeManifest);
      if (revokedDomains.has(domain)) {
        log.info(
          { domain, revokedCount: revokedDomains.size },
          'Revoking projection: source domain appears in revoked_publisher_domains[] — retiring all writer-owned catalog rows for this publisher'
        );
        // Soft-delete every writer-owned CAA row for this publisher.
        // currentCanonical is empty: no authorized_agents[] entries
        // survive revocation. The OR-chain matches all three writer
        // shapes (publisher-wide, property_rid-keyed, slug-keyed).
        await client.query(
          `UPDATE catalog_agent_authorizations caa
              SET deleted_at = NOW()
            WHERE caa.evidence = 'adagents_json'
              AND caa.created_by = 'system'
              AND caa.deleted_at IS NULL
              AND (
                caa.publisher_domain = $1
                OR caa.property_rid IN (
                  SELECT property_rid FROM catalog_properties WHERE created_by = $2
                )
                OR (caa.property_id_slug IS NOT NULL AND caa.property_rid IN (
                  SELECT property_rid FROM catalog_properties WHERE created_by = $2
                ))
              )`,
          [domain, adagentsCreatedBy(domain)],
        );
        collectionEvents.push(
          ...await this.collectionCatalog.retireMissingAdagentsCollections(
            client,
            domain,
            [],
            adagentsCreatedBy(domain),
          ),
        );
        if (input.eventsDb && collectionEvents.length > 0) {
          await input.eventsDb.writeEvents(
            collectionProjectionWriteEvents(
              collectionEvents,
              input.collectionEventActor ?? 'pipeline:catalog_crawl',
            ),
            client,
          );
        }
        await client.query('COMMIT');
        return { collectionEvents };
      }

      const properties = Array.isArray(safeManifest.properties) ? safeManifest.properties : [];
      for (let i = 0; i < properties.length; i += 1) {
        const savepoint = `prop_${i}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await this.projectPropertyToCatalog(client, domain, properties[i]);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          log.warn(
            {
              domain,
              propertyId: properties[i]?.property_id,
              propertyIndex: i,
              err: err instanceof Error ? err.message : err,
            },
            'Catalog projection failed for property; skipping'
          );
        }
      }

      const collections = Array.isArray(safeManifest.collections) ? safeManifest.collections : [];
      const currentCollectionIds = collections
        .map((collection) => collection?.collection_id)
        .filter((collectionId): collectionId is string =>
          typeof collectionId === 'string' && collectionId.trim().length > 0
        )
        .map((collectionId) => collectionId.trim());
      collectionEvents.push(
        ...await this.collectionCatalog.retireMissingAdagentsCollections(
          client,
          domain,
          currentCollectionIds,
          adagentsCreatedBy(domain),
        ),
      );
      for (let i = 0; i < collections.length; i += 1) {
        const collection = collections[i];
        const savepoint = `collection_${i}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          const event = await this.collectionCatalog.projectCollection(client, {
            publisherDomain: domain,
            collection: collection as Record<string, unknown>,
            evidence: 'adagents_json',
            confidence: 'authoritative',
            source: 'authoritative',
            adagentsUrl: `https://${domain}/.well-known/adagents.json`,
            createdBy: adagentsCreatedBy(domain),
          });
          if (event) collectionEvents.push(event);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          log.warn(
            {
              domain,
              collectionId: collection?.collection_id,
              collectionIndex: i,
              err: err instanceof Error ? err.message : err,
            },
            'Catalog projection failed for collection; skipping'
          );
        }
      }

      // Project authorized_agents → catalog_agent_authorizations. Each
      // entry runs in its own savepoint so a malformed entry doesn't
      // lose the rest of the manifest. Identity-side projection (above)
      // ran first so property_ids slugs can be resolved against
      // catalog_properties rows the writer just created.
      const authEntries = Array.isArray(safeManifest.authorized_agents)
        ? safeManifest.authorized_agents
        : [];
      for (let i = 0; i < authEntries.length; i += 1) {
        const savepoint = `auth_${i}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await this.projectAuthorizationToCatalog(client, domain, authEntries[i]);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          log.warn(
            {
              domain,
              agentUrl: authEntries[i]?.url,
              authIndex: i,
              err: err instanceof Error ? err.message : err,
            },
            'Catalog auth projection failed for entry; skipping'
          );
        }
      }

      // Reconcile: soft-delete catalog rows for agents that USED to be
      // authorized by this manifest but no longer appear. Without this
      // the writer is upsert-only and an agent removed from the
      // publisher's adagents.json would linger in the index forever
      // (the original wonderstruck-shaped follow-up bug). Scoped to
      // writer-sourced rows (`evidence='adagents_json'`,
      // `created_by='system'`) so promotions, agent_claim rows, and
      // third-party-attested rows are untouched.
      const currentCanonical = authEntries
        .map(e => (e?.url && typeof e.url === 'string' ? canonicalizeAgentUrl(e.url) : null))
        .filter((c): c is string => !!c);
      // Catalog rows for this publisher live under either
      //   publisher_domain = $1   (publisher-wide rows)
      //   property_rid IN (catalog_properties.created_by='adagents_json:$1')
      //   property_id_slug IS NOT NULL with created_by='adagents_json:$1' (slug-keyed)
      // The OR-chain covers all three writer shapes.
      await client.query(
        `UPDATE catalog_agent_authorizations caa
            SET deleted_at = NOW()
          WHERE caa.evidence = 'adagents_json'
            AND caa.created_by = 'system'
            AND caa.deleted_at IS NULL
            AND NOT (caa.agent_url_canonical = ANY($2::text[]))
            AND (
              caa.publisher_domain = $1
              OR caa.property_rid IN (
                SELECT property_rid FROM catalog_properties WHERE created_by = $3
              )
              OR (caa.property_id_slug IS NOT NULL AND caa.property_rid IN (
                SELECT property_rid FROM catalog_properties WHERE created_by = $3
              ))
            )`,
        [domain, currentCanonical, adagentsCreatedBy(domain)],
      );

      if (input.eventsDb && collectionEvents.length > 0) {
        await input.eventsDb.writeEvents(
          collectionProjectionWriteEvents(
            collectionEvents,
            input.collectionEventActor ?? 'pipeline:catalog_crawl',
          ),
          client,
        );
      }

      await client.query('COMMIT');
      return { collectionEvents };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read the cached adagents.json body for a domain. Used by the crawler
   * to decide whether a re-fetch produced an actual content change before
   * fanning out manager re-validation. Returns null when the domain has
   * never been successfully crawled.
   */
  async getCachedAdagentsJson(domain: string): Promise<AdagentsManifest | null> {
    const client = await getClient();
    try {
      const r = await client.query<{ adagents_json: AdagentsManifest | null }>(
        `SELECT adagents_json FROM publishers WHERE domain = $1 LIMIT 1`,
        [canonicalizePublisherDomain(domain)],
      );
      return r.rows[0]?.adagents_json ?? null;
    } finally {
      client.release();
    }
  }

  /**
   * Insert one queue row per publisher delegating to this manager via
   * ads.txt MANAGERDOMAIN. Idempotent: if a publisher is already queued
   * (e.g. previous fan-out hasn't drained yet), the row is reset to
   * "due now" with attempts=0 so the upstream manager change supersedes
   * any in-flight backoff. Returns the number of rows touched (inserts
   * + ON CONFLICT updates) — a delegating publisher with a stale row
   * still counts since the supersede is the load-bearing semantic.
   *
   * The SELECT scans the partial index added in migration 470
   * (idx_publishers_manager_domain) so the lookup stays cheap even at
   * managed-network scale.
   */
  async enqueueManagerRevalidation(managerDomain: string): Promise<number> {
    const client = await getClient();
    try {
      const r = await client.query(
        `INSERT INTO manager_revalidation_queue
           (publisher_domain, manager_domain, enqueued_at, next_attempt_after, attempts, last_attempted_at, last_error)
         SELECT domain, $1, NOW(), NOW(), 0, NULL, NULL
           FROM publishers
          WHERE manager_domain = $1
         ON CONFLICT (publisher_domain) DO UPDATE SET
           manager_domain = EXCLUDED.manager_domain,
           enqueued_at = NOW(),
           next_attempt_after = NOW(),
           attempts = 0,
           last_attempted_at = NULL,
           last_error = NULL`,
        [canonicalizePublisherDomain(managerDomain)],
      );
      return r.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  /**
   * Pull a bounded batch of due rows from the queue. The caller (crawler
   * worker tick) must call markRevalidationSucceeded / Failed for each
   * returned row to advance the queue.
   */
  async dequeueRevalidationBatch(
    limit: number,
  ): Promise<Array<{ publisher_domain: string; manager_domain: string; attempts: number }>> {
    const client = await getClient();
    try {
      const r = await client.query<{
        publisher_domain: string;
        manager_domain: string;
        attempts: number;
      }>(
        `SELECT publisher_domain, manager_domain, attempts
           FROM manager_revalidation_queue
          WHERE next_attempt_after <= NOW()
          ORDER BY enqueued_at ASC
          LIMIT $1`,
        [limit],
      );
      return r.rows;
    } finally {
      client.release();
    }
  }

  async markRevalidationSucceeded(publisherDomain: string): Promise<void> {
    const client = await getClient();
    try {
      await client.query(
        `DELETE FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [canonicalizePublisherDomain(publisherDomain)],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Advance the queue row with exponential backoff. Schedule mirrors the
   * catalog_crawl_queue cadence (1h / 6h / 24h / 72h) so a manager whose
   * file is briefly unparseable doesn't clog the queue forever.
   */
  async markRevalidationFailed(publisherDomain: string, err: string): Promise<void> {
    const client = await getClient();
    try {
      await client.query(
        `UPDATE manager_revalidation_queue
            SET attempts = attempts + 1,
                last_attempted_at = NOW(),
                last_error = LEFT($2, 500),
                next_attempt_after = NOW() + CASE
                  WHEN attempts < 1 THEN INTERVAL '1 hour'
                  WHEN attempts < 2 THEN INTERVAL '6 hours'
                  WHEN attempts < 3 THEN INTERVAL '1 day'
                  ELSE INTERVAL '3 days'
                END
          WHERE publisher_domain = $1`,
        [canonicalizePublisherDomain(publisherDomain), err],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Project a single adagents.json property into catalog_properties +
   * catalog_identifiers. Catalog rows are tagged
   * evidence='adagents_json' / confidence='authoritative' so a property
   * crawled now is indistinguishable from one seeded by migration 336.
   *
   * Tenant isolation rules — load-bearing for catalog correctness:
   *
   *  1. Cross-publisher domain claims are refused. A `domain` or `subdomain`
   *     identifier in the property must lexically belong to the publisher
   *     (equal to or a subdomain of publisherDomain). Otherwise the entire
   *     property is dropped — a manifest at attacker.example cannot land an
   *     authoritative claim for `domain:victim.example`.
   *
   *  2. Cross-publisher rid reuse is refused. If any matched rid was
   *     authored by another publisher's adagents.json, refuse — even
   *     ON CONFLICT DO NOTHING on the identifier insert wouldn't stop a
   *     reuse-branch UPDATE from rebinding adagents_url.
   *
   *  3. Multi-rid conflation is refused. If the identifier set spans
   *     multiple distinct existing rids, silent merging requires human
   *     review (catalog_disputes).
   *
   *  4. Foreign-rid reuse requires an anchor. If the matched rid was created
   *     by a non-adagents source (system seed, community, brand_json, member
   *     resolve), reuse is only allowed when the property carries at least
   *     one publisher-anchored identifier. Without this, an unanchored
   *     manifest can reach a seed rid via a bundle ID and overwrite its
   *     adagents_url via COALESCE.
   *
   *  5. Otherwise, reuse the single matching own-rid (re-crawl) or mint
   *     a new one. Identifiers go in with ON CONFLICT DO NOTHING so a
   *     non-anchor identifier already claimed by another rid silently
   *     drops rather than rebinding.
   */
  private async projectPropertyToCatalog(
    client: PoolClient,
    publisherDomain: string,
    property: AdagentsProperty,
  ): Promise<void> {
    const rawIdentifiers = Array.isArray(property.identifiers) ? property.identifiers : [];
    const identifiers = rawIdentifiers
      .filter((i): i is { type: string; value: string } =>
        typeof i?.type === 'string' && typeof i?.value === 'string' && i.type.length > 0 && i.value.length > 0
      )
      .map((i) => {
        const norm = normalizeIdentifier(i.type, i.value);
        // catalog_identifiers.chk_identifier_lowercase requires the entire value
        // to be lowercase. normalizeRssUrl preserves URL path case, and any
        // future identifier type may also leak case; lowercase defensively to
        // match the migration 336 seed and avoid silent rollbacks.
        return { type: norm.type, value: norm.value.toLowerCase() };
      });

    if (identifiers.length === 0) return;

    // Rule 1 — refuse cross-publisher domain claims.
    const crossPublisherClaims = identifiers.filter(
      (i) =>
        (i.type === 'domain' || i.type === 'subdomain')
        && !isPublisherDomainAnchor(publisherDomain, i.type, i.value)
    );
    if (crossPublisherClaims.length > 0) {
      log.warn(
        {
          publisherDomain,
          propertyId: property.property_id,
          crossPublisherClaims,
        },
        'Catalog projection refused: property declares domain identifiers outside the publisher\'s domain'
      );
      return;
    }

    const hasAnchor = identifiers.some((i) =>
      isPublisherDomainAnchor(publisherDomain, i.type, i.value)
    );

    const tupleParams: unknown[] = [];
    const tuplePlaceholders = identifiers
      .map((ident, i) => {
        tupleParams.push(ident.type, ident.value);
        return `($${i * 2 + 1}, $${i * 2 + 2})`;
      })
      .join(', ');

    // ORDER BY for determinism: when multiple distinct rids match, the same
    // input always picks the same one (oldest first), so re-runs converge.
    const existing = await client.query<{ property_rid: string; created_by: string | null }>(
      `SELECT DISTINCT cp.property_rid, cp.created_by
         FROM catalog_identifiers ci
         JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
        WHERE (ci.identifier_type, ci.identifier_value) IN (${tuplePlaceholders})
        ORDER BY cp.created_by, cp.property_rid`,
      tupleParams
    );

    const expectedCreatedBy = adagentsCreatedBy(publisherDomain);

    // Rule 2 — refuse cross-publisher rid reuse.
    const conflicting = existing.rows.filter((r) =>
      typeof r.created_by === 'string'
      && r.created_by.startsWith(ADAGENTS_CREATED_BY_PREFIX)
      && r.created_by !== expectedCreatedBy
    );
    if (conflicting.length > 0) {
      log.warn(
        {
          publisherDomain,
          propertyId: property.property_id,
          conflictingCreatedBy: conflicting.map((r) => r.created_by),
          conflictingRids: conflicting.map((r) => r.property_rid),
        },
        'Catalog projection refused: property identifiers are claimed by another publisher manifest'
      );
      return;
    }

    // Rule 3 — refuse multi-rid conflation.
    const ownRids = Array.from(new Set(existing.rows.map((r) => r.property_rid)));
    if (ownRids.length > 1) {
      log.warn(
        { publisherDomain, propertyId: property.property_id, rids: ownRids },
        'Catalog projection refused: identifier set spans multiple existing properties (merge requires moderation)'
      );
      return;
    }

    const adagentsUrl = `https://${publisherDomain}/.well-known/adagents.json`;
    let propertyRid: string;

    if (ownRids.length === 1) {
      const matchedCreatedBy = existing.rows[0].created_by;
      const isOwnRecrawl = matchedCreatedBy === expectedCreatedBy;

      // Rule 4 — foreign rid reuse requires an anchor. The publisher must
      // produce a domain/subdomain identifier under their own domain to take
      // ownership of (or update adagents_url on) a rid created by another
      // source. Without this, a manifest declaring only a bundle ID could
      // reach a seed rid via that bundle ID and rebind adagents_url.
      if (!isOwnRecrawl && !hasAnchor) {
        log.warn(
          {
            publisherDomain,
            propertyId: property.property_id,
            matchedCreatedBy,
            matchedRid: ownRids[0],
          },
          'Catalog projection refused: cannot adopt a non-adagents rid without a publisher-anchored identifier'
        );
        return;
      }

      propertyRid = ownRids[0];
      // Anchor-adopt promotion: when a publisher's adagents.json claims a rid
      // previously created by community/enrichment/contributed flows AND
      // anchors via a domain identifier under their own host, the publisher
      // is now the source-of-truth pipeline for this property. Promote
      // source → 'authoritative' and rebind created_by →
      // 'adagents_json:<publisher>' so downstream queries that filter by
      // created_by (auth projection in projectAuthorizationToCatalog,
      // publisher_domain derivation in v_effective_agent_authorizations)
      // see this row as a publisher-owned authoritative entry. Without
      // this rebind, the auth projection's
      // `WHERE created_by = 'adagents_json:<pub>' AND property_id = ANY(...)`
      // returns 0 rows for properties that were already in the catalog
      // under a different pipeline — silently dropping the manifest's
      // authorized_agents[] entries on the floor.
      //
      // Own re-crawls (matchedCreatedBy === expectedCreatedBy) re-set
      // source_updated_at without changing created_by; the SET below is
      // idempotent for that case.
      await client.query(
        `UPDATE catalog_properties SET
           source_updated_at = NOW(),
           updated_at = NOW(),
           adagents_url = COALESCE(adagents_url, $2),
           property_id = COALESCE(property_id, $3),
           source = 'authoritative',
           created_by = $4
         WHERE property_rid = $1`,
        [propertyRid, adagentsUrl, property.property_id ?? null, expectedCreatedBy]
      );
    } else {
      propertyRid = uuidv7();
      await client.query(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, adagents_url, created_by)
         VALUES ($1, $2, 'property', 'authoritative', 'active', $3, $4)`,
        [propertyRid, property.property_id ?? null, adagentsUrl, expectedCreatedBy]
      );
    }

    for (const ident of identifiers) {
      await client.query(
        `INSERT INTO catalog_identifiers
           (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES ($1, $2, $3, $4, 'adagents_json', 'authoritative')
         ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
        [uuidv7(), propertyRid, ident.type, ident.value]
      );
    }
  }

  /**
   * Project a single authorized_agents[] entry into
   * catalog_agent_authorizations.
   *
   * v1 covers three of the six authorization_type variants the spec
   * enumerates:
   *   - property_ids        — one row per resolved property_rid
   *   - inline_properties   — same shape using the entry's inline
   *                           properties[] (the writer projects those
   *                           to catalog first, then references them)
   *   - publisher_properties — only the lexical-anchor case lands
   *                            (entry.publisher_domain == publisherDomain)
   *                            with selection_type='all' or 'by_id'.
   *                            Cross-publisher claims and 'by_tag' are
   *                            refused per spec.
   *   - no authorization_type (publisher-wide) — one row with
   *                            property_rid IS NULL, publisher_domain set
   *
   * Variants explicitly skipped:
   *   - property_tags, signal_ids, signal_tags — deferred per spec.
   *     The legacy agent_publisher_authorizations table continues to
   *     serve these via the UNION reader during dual-read.
   *
   * Security:
   *   - agent_url canonicalization at the writer matches the schema
   *     CHECK (lowercase + no trailing slash; embedded '*' rejected).
   *   - publisher_properties cross-publisher refusal via the anchor rule.
   *   - property_ids slugs that don't resolve to a catalog_properties
   *     row owned by this publisher are skipped (legacy-only data
   *     served by UNION reader).
   *
   * evidence='adagents_json', created_by='system' for all writer-sourced
   * rows. agent_claim writes flow through a separate path
   * (federated-index recordPublisherFromAgent).
   */
  private async projectAuthorizationToCatalog(
    client: PoolClient,
    publisherDomain: string,
    entry: AdagentsAuthorizedAgent,
  ): Promise<void> {
    if (!entry?.url || typeof entry.url !== 'string') return;
    const agentCanonical = canonicalizeAgentUrl(entry.url);
    if (agentCanonical === null) {
      log.warn(
        { publisherDomain, agentUrl: entry.url },
        'Skipping auth projection: agent_url failed canonicalization'
      );
      return;
    }
    const agentRaw = entry.url.trim();
    const authorizedFor = typeof entry.authorized_for === 'string'
      ? entry.authorized_for.slice(0, 500)
      : null;

    const variant = entry.authorization_type;

    if (variant === 'property_tags' || variant === 'signal_ids' || variant === 'signal_tags') {
      // Deferred per spec. Legacy table serves these.
      log.debug(
        { publisherDomain, agentUrl: agentCanonical, variant },
        'Skipping auth projection: variant not supported in v1'
      );
      return;
    }

    // Resolve the set of (property_rid OR publisher-wide) targets for this entry.
    const targets: Array<{ propertyRid: string | null; slug: string | null }> = [];

    if (variant === 'property_ids') {
      const slugs = Array.isArray(entry.property_ids)
        ? entry.property_ids.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      if (slugs.length === 0) return;
      const rows = await client.query<{ property_rid: string; property_id: string }>(
        `SELECT property_rid, property_id
           FROM catalog_properties
          WHERE created_by = $1 AND property_id = ANY($2)`,
        [adagentsCreatedBy(publisherDomain), slugs]
      );
      for (const row of rows.rows) {
        targets.push({ propertyRid: row.property_rid, slug: row.property_id });
      }
    } else if (variant === 'inline_properties') {
      // Inline properties were just projected (they ride in entry.properties[]
      // and get the same security guards as top-level properties via the
      // existing project loop). Resolve their rids the same way as
      // property_ids, keyed on the publisher's manifest slug.
      const inline = Array.isArray(entry.properties) ? entry.properties : [];
      // First, project each inline property — the entry's own properties[]
      // wasn't visited by the top-level loop because they live inside this
      // auth entry, not the manifest's top-level properties[]. A failure
      // in any inline projection aborts the postgres transaction; the
      // outer per-entry SAVEPOINT (auth_${i} in upsertAdagentsCache) owns
      // the rollback boundary, so a single bad inline property drops the
      // whole entry — all-or-nothing per entry.
      for (const prop of inline) {
        await this.projectPropertyToCatalog(client, publisherDomain, prop);
      }
      const slugs = inline
        .map((p) => p?.property_id)
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (slugs.length > 0) {
        const rows = await client.query<{ property_rid: string; property_id: string }>(
          `SELECT property_rid, property_id
             FROM catalog_properties
            WHERE created_by = $1 AND property_id = ANY($2)`,
          [adagentsCreatedBy(publisherDomain), slugs]
        );
        for (const row of rows.rows) {
          targets.push({ propertyRid: row.property_rid, slug: row.property_id });
        }
      }
    } else if (variant === 'publisher_properties') {
      const sels = Array.isArray(entry.publisher_properties) ? entry.publisher_properties : [];
      for (const sel of sels) {
        // The spec requires XOR — exactly one of `publisher_domain` (singular)
        // or `publisher_domains[]` (compact) is present on each selector. A
        // manifest with both populated is malformed and dangerous: a writer
        // that accepts the union turns a singular-points-at-victim + plural-
        // points-at-source shape into an unintended permissive projection.
        // Refuse and log rather than picking a winner.
        const hasSingular = typeof sel?.publisher_domain === 'string' && sel.publisher_domain.length > 0;
        const hasPlural = Array.isArray(sel?.publisher_domains) && sel.publisher_domains.length > 0;
        if (hasSingular && hasPlural) {
          log.warn(
            { publisherDomain, agentUrl: agentCanonical, selPub: sel.publisher_domain, selPubsCount: sel.publisher_domains?.length },
            'Skipping auth projection: publisher_properties entry violates singular/plural XOR (both present)'
          );
          continue;
        }
        // A selector claims the publisher if the source publisherDomain matches
        // either the singular publisher_domain or any entry in the compact
        // publisher_domains[] array. Both forms are equivalent for projection.
        const selPubSingular = hasSingular ? canonicalizePublisherDomain(sel.publisher_domain!) : null;
        const selPubInList = hasPlural
          && sel.publisher_domains!.some((d) => typeof d === 'string' && canonicalizePublisherDomain(d) === publisherDomain);
        if (selPubSingular !== publisherDomain && !selPubInList) {
          // Cross-publisher third-party-sales claim. Refused per spec — the
          // writer cannot land an authoritative row for another publisher's
          // properties without out-of-band corroboration.
          log.warn(
            {
              publisherDomain,
              agentUrl: agentCanonical,
              selPub: selPubSingular,
              selPubsCount: hasPlural ? sel.publisher_domains!.length : 0,
            },
            'Skipping auth projection: publisher_properties claims a different publisher (cross-publisher refused)'
          );
          continue;
        }
        const selectionType = sel?.selection_type;
        if (selectionType === 'all') {
          const rows = await client.query<{ property_rid: string; property_id: string | null }>(
            `SELECT property_rid, property_id
               FROM catalog_properties
              WHERE created_by = $1`,
            [adagentsCreatedBy(publisherDomain)]
          );
          for (const row of rows.rows) {
            targets.push({ propertyRid: row.property_rid, slug: row.property_id });
          }
        } else if (selectionType === 'by_id') {
          const slugs = Array.isArray(sel.property_ids)
            ? sel.property_ids.filter((s): s is string => typeof s === 'string' && s.length > 0)
            : [];
          if (slugs.length === 0) continue;
          const rows = await client.query<{ property_rid: string; property_id: string }>(
            `SELECT property_rid, property_id
               FROM catalog_properties
              WHERE created_by = $1 AND property_id = ANY($2)`,
            [adagentsCreatedBy(publisherDomain), slugs]
          );
          for (const row of rows.rows) {
            targets.push({ propertyRid: row.property_rid, slug: row.property_id });
          }
        } else {
          // selection_type='by_tag' is deferred per spec.
          log.debug(
            { publisherDomain, agentUrl: agentCanonical, selectionType },
            'Skipping auth projection: publisher_properties.selection_type not supported in v1'
          );
        }
      }
    } else {
      // No authorization_type → publisher-wide auth (legacy
      // agent_publisher_authorizations shape). One row with
      // property_rid IS NULL, publisher_domain set.
      targets.push({ propertyRid: null, slug: null });
    }

    if (targets.length === 0) {
      log.debug(
        { publisherDomain, agentUrl: agentCanonical, variant },
        'Auth projection produced no rows (no resolved targets)'
      );
      return;
    }

    // Insert one CAA row per resolved target. Partial unique index
    // (active-set) handles re-crawls — second writer wins on collision.
    for (const target of targets) {
      const isPropertyScope = target.propertyRid !== null;
      await client.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, property_rid, property_id_slug,
            publisher_domain, authorized_for, evidence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'adagents_json', 'system')
         ON CONFLICT (agent_url_canonical,
                      (COALESCE(property_rid::text, '')),
                      (COALESCE(publisher_domain, '')),
                      evidence)
                WHERE deleted_at IS NULL
         DO UPDATE SET
           authorized_for = EXCLUDED.authorized_for,
           updated_at = NOW()`,
        [
          agentRaw,
          agentCanonical,
          target.propertyRid,
          target.slug,
          isPropertyScope ? null : publisherDomain,
          authorizedFor,
        ]
      );
    }
  }
}
