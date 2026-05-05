/**
 * Hosted-property → federated-index sync.
 *
 * `hosted_properties` is the authoritative table for publishers who let AAO
 * serve their adagents.json. The federated index (`discovered_properties`,
 * `discovered_agents`, `agent_publisher_authorizations`) is otherwise
 * populated by the crawler walking external `/.well-known/adagents.json`
 * files. Without this sync, AAO-hosted publishers would never appear in the
 * agent authorization graph that powers `/api/registry/publisher` and the
 * downstream lookups.
 *
 * Trust-label semantics:
 *  - Sync writes `source='aao_hosted'` rows, NOT `source='adagents_json'`.
 *    `adagents_json` is reserved for rows where the publisher's origin
 *    actually serves the document (crawler-verified, including following
 *    `authoritative_location` stubs). Until origin verification happens,
 *    AAO-hosted authorization is the publisher's stated intent — not
 *    an origin-attested claim. Mixing the two labels would over-claim
 *    on the agent's behalf.
 *
 * Reconciliation semantics:
 *  - Authorizations: full reconcile, scoped to `source='aao_hosted'` for
 *    this publisher_domain. We own that source label exclusively;
 *    crawler-written `adagents_json` rows for the same domain are left
 *    untouched (they represent verified origin facts).
 *  - Properties: full reconcile. This sync is the authoritative source
 *    for the publisher_domain's property list — any row not in the current
 *    manifest is deleted, regardless of `source`. Source is still written
 *    as `'aao_hosted'` on new rows; on conflict with a crawler row, the
 *    crawler's source label is preserved (origin-verified > hosted-only)
 *    but the sync still owns the reconcile (the publisher's manifest is
 *    the truth for which properties exist). Runs inside a domain-scoped
 *    advisory-lock transaction to prevent concurrent-sync interleave races.
 *  - Publisher row: keyed by stable sentinel (`AAO_HOSTED_SENTINEL`) so
 *    re-syncs collapse to the same row regardless of which agent is first
 *    in the manifest.
 *
 * Returns counts + a per-row failure count. Throws if everything failed —
 * partial success is logged but does not bubble up, so callers see a
 * structured result rather than a half-completed write that swallowed
 * errors silently.
 */
import type { HostedProperty } from '../types.js';
import { FederatedIndexDatabase } from '../db/federated-index-db.js';
import { query, getClient } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('hosted-property-sync');

/** Stable `discovered_by_agent` value for AAO-hosted publisher rows. */
export const AAO_HOSTED_SENTINEL = 'aao://hosted';

export interface HostedSyncResult {
  properties_synced: number;
  properties_removed: number;
  agents_synced: number;
  authorizations_reconciled: number;
  authorizations_removed: number;
  publisher_synced: boolean;
  errors: number;
}

interface AdagentsAgent {
  url?: unknown;
  authorized_for?: unknown;
}

interface AdagentsProperty {
  property_id?: unknown;
  type?: unknown;
  name?: unknown;
  identifiers?: unknown;
  tags?: unknown;
}

function readAgents(adagents: Record<string, unknown>): AdagentsAgent[] {
  return Array.isArray(adagents.authorized_agents)
    ? (adagents.authorized_agents as AdagentsAgent[])
    : [];
}

function readProperties(adagents: Record<string, unknown>): AdagentsProperty[] {
  return Array.isArray(adagents.properties)
    ? (adagents.properties as AdagentsProperty[])
    : [];
}

export async function syncHostedPropertyToFederatedIndex(
  hosted: HostedProperty,
  fedDb: FederatedIndexDatabase = new FederatedIndexDatabase(),
): Promise<HostedSyncResult> {
  const result: HostedSyncResult = {
    properties_synced: 0,
    properties_removed: 0,
    agents_synced: 0,
    authorizations_reconciled: 0,
    authorizations_removed: 0,
    publisher_synced: false,
    errors: 0,
  };
  if (!hosted.is_public) return result;
  const adagents = hosted.adagents_json || {};
  const domain = hosted.publisher_domain.toLowerCase();
  const agents = readAgents(adagents);
  const properties = readProperties(adagents);

  // Properties: upsert + full reconcile under a domain-scoped advisory lock.
  // The lock prevents two concurrent syncs for the same domain from interleaving
  // their upserts with the trailing DELETE, which would cause the second sync's
  // delete to remove rows the first sync just wrote (and vice versa).
  {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5000ms'`);
      await client.query(`SET LOCAL statement_timeout = '30000ms'`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dp:${domain}`]);

      const propertyNames: string[] = [];
      const propertyTypes: string[] = [];
      let synced = 0;
      for (const p of properties) {
        if (typeof p.name !== 'string' || !p.name) continue;
        const propType = typeof p.type === 'string' && p.type ? p.type : 'website';
        propertyNames.push(p.name);
        propertyTypes.push(propType);
        await client.query(
          `INSERT INTO discovered_properties (
             property_id, publisher_domain, property_type, name, identifiers, tags, source
           ) VALUES ($1, $2, $3, $4, $5, $6, 'aao_hosted')
           ON CONFLICT (publisher_domain, name, property_type) DO UPDATE SET
             property_id = COALESCE(EXCLUDED.property_id, discovered_properties.property_id),
             -- Preserve crawler-attested identifiers/tags: they represent origin-verified
             -- facts and take precedence over hosted-manifest values.
             identifiers = CASE WHEN discovered_properties.source = 'crawler'
                                THEN discovered_properties.identifiers
                                ELSE EXCLUDED.identifiers END,
             tags = CASE WHEN discovered_properties.source = 'crawler'
                         THEN discovered_properties.tags
                         ELSE EXCLUDED.tags END,
             last_validated = NOW(),
             source = CASE WHEN discovered_properties.source = 'crawler'
                           THEN 'crawler'
                           ELSE 'aao_hosted' END`,
          [
            typeof p.property_id === 'string' ? p.property_id : null,
            domain,
            propType,
            p.name,
            JSON.stringify(Array.isArray(p.identifiers) ? p.identifiers : []),
            Array.isArray(p.tags) ? p.tags : [],
          ]
        );
        synced++;  // after await: counts only confirmed writes
      }

      // Reconcile: the hosted manifest is authoritative for this publisher's
      // property list. Delete any row — regardless of source — whose
      // (name, property_type) is not in the current manifest. This covers
      // both aao_hosted rows (we wrote them) and crawler rows that were later
      // removed from the manifest (the publisher's intent takes precedence).
      // Keyed on (name, property_type) — not name alone — so a property
      // reclassified to a different type is correctly removed.
      const deleteResult = propertyNames.length > 0
        ? await client.query(
            `DELETE FROM discovered_properties
              WHERE publisher_domain = $1
                AND NOT EXISTS (
                  SELECT 1 FROM unnest($2::text[], $3::text[]) AS m(mname, mtype)
                  WHERE m.mname = discovered_properties.name
                    AND m.mtype = discovered_properties.property_type
                )`,
            [domain, propertyNames, propertyTypes],
          )
        : await client.query(
            // Empty manifest: publisher has declared zero properties. Delete all
            // rows for the domain — the hosted manifest is authoritative and the
            // publisher's intent (empty list) takes precedence over any
            // crawler-attested rows that may exist.
            `DELETE FROM discovered_properties WHERE publisher_domain = $1`,
            [domain],
          );

      await client.query('COMMIT');
      // Only update counters after commit so partial-rollback doesn't skew them.
      result.properties_synced = synced;
      result.properties_removed = deleteResult.rowCount ?? 0;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore rollback failures */ }
      result.errors++;
      logger.warn({ err, domain }, 'Failed to sync/reconcile hosted property rows');
    } finally {
      client.release();
    }
  }

  // Agents: upsert each, then reconcile authorizations.
  const validAgentUrls: string[] = [];
  for (const a of agents) {
    if (typeof a.url !== 'string' || !a.url) continue;
    const agentUrl = a.url;
    validAgentUrls.push(agentUrl);
    try {
      await fedDb.upsertAgent({
        agent_url: agentUrl,
        source_type: 'adagents_json',
        source_domain: domain,
      });
      result.agents_synced++;
      await fedDb.upsertAuthorization({
        agent_url: agentUrl,
        publisher_domain: domain,
        authorized_for: typeof a.authorized_for === 'string' ? a.authorized_for : undefined,
        // `aao_hosted` rather than `adagents_json` — the publisher's
        // origin has not been verified yet. Promotion to the stronger
        // label is an explicit verification step (future work).
        source: 'aao_hosted',
      });
      result.authorizations_reconciled++;
    } catch (err) {
      result.errors++;
      logger.warn({ err, domain, agentUrl }, 'Failed to upsert hosted authorization row');
    }
  }

  // Reconcile: delete any (publisher_domain, source='aao_hosted') rows
  // not in the current manifest. Scoped to `aao_hosted` only — we don't
  // touch crawler-written `adagents_json` rows or `agent_claim` rows,
  // both of which represent attestations we don't own.
  try {
    const removeResult = validAgentUrls.length > 0
      ? await query(
          `DELETE FROM agent_publisher_authorizations
            WHERE publisher_domain = $1
              AND source = 'aao_hosted'
              AND agent_url <> ALL($2::text[])`,
          [domain, validAgentUrls],
        )
      : await query(
          `DELETE FROM agent_publisher_authorizations
            WHERE publisher_domain = $1 AND source = 'aao_hosted'`,
          [domain],
        );
    result.authorizations_removed = removeResult.rowCount ?? 0;
  } catch (err) {
    result.errors++;
    logger.warn({ err, domain }, 'Failed to reconcile hosted authorizations');
  }

  // Publisher row, keyed on the stable sentinel — survives agent-list
  // reordering and missing-agent edge cases without leaking duplicate rows.
  // We deliberately do NOT set has_valid_adagents=true here — that flag
  // means the publisher's origin actually serves a valid document, which
  // hosted-on-AAO does not establish until origin verification happens.
  // The crawler is the only writer that should flip has_valid_adagents.
  try {
    await fedDb.upsertPublisher({
      domain,
      discovered_by_agent: AAO_HOSTED_SENTINEL,
    });
    result.publisher_synced = true;
  } catch (err) {
    result.errors++;
    logger.warn({ err, domain }, 'Failed to upsert hosted publisher row');
  }

  if (result.errors > 0 && result.properties_synced === 0 && result.agents_synced === 0) {
    throw new Error(`Hosted property sync failed for ${domain}: ${result.errors} errors`);
  }

  return result;
}
