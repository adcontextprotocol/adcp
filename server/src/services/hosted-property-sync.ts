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
 *  - Properties: additive only. `discovered_properties` has no source
 *    column, so we cannot safely distinguish hosted-written rows from
 *    crawler-written rows. Removed properties persist until manually
 *    cleared. Tracked as a follow-up — adding a `source` column to
 *    `discovered_properties` would let us reconcile here too.
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
import { query } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('hosted-property-sync');

/** Stable `discovered_by_agent` value for AAO-hosted publisher rows. */
export const AAO_HOSTED_SENTINEL = 'aao://hosted';

export interface HostedSyncResult {
  properties_synced: number;
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

  // Properties: additive upsert (see file-level comment for why removal
  // is not yet supported).
  for (const p of properties) {
    if (typeof p.name !== 'string' || !p.name) continue;
    const propType = typeof p.type === 'string' && p.type ? p.type : 'website';
    try {
      await fedDb.upsertProperty({
        property_id: typeof p.property_id === 'string' ? p.property_id : undefined,
        publisher_domain: domain,
        property_type: propType,
        name: p.name,
        identifiers: Array.isArray(p.identifiers)
          ? (p.identifiers as Array<{ type: string; value: string }>)
          : [],
        tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
      });
      result.properties_synced++;
    } catch (err) {
      result.errors++;
      logger.warn({ err, domain, name: p.name }, 'Failed to upsert hosted property row');
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

/**
 * Promote `aao_hosted` rows for a publisher's manifest agents up to the
 * stronger `adagents_json` label. Called by the origin verifier after a
 * successful round-trip fetch confirms the publisher's
 * /.well-known/adagents.json points at AAO via `authoritative_location`.
 *
 * Scoped to `(publisher_domain, source='aao_hosted', agent_url IN $2)`
 * so we only touch rows we wrote in `syncHostedPropertyToFederatedIndex`
 * — crawler-written rows and unrelated agents are not promoted.
 *
 * Reversal: re-running `syncHostedPropertyToFederatedIndex` rewrites
 * the rows as `aao_hosted` (its UPSERT conflict key is
 * `(agent_url, publisher_domain, source)` so the `adagents_json` row
 * persists alongside the new `aao_hosted` row, but readers UNION-
 * dedupe by `(agent_url, publisher_domain, source)`). For a clean
 * demote on verification failure, the verifier passes verified=false
 * to `propertyDb.recordOriginVerification` and a future re-sync handles
 * the actual row state — the source label is then implicitly the
 * `aao_hosted` re-write. If a hard demote is needed, run the inverse
 * UPDATE: `source='aao_hosted' WHERE source='adagents_json' AND ...`.
 */
export async function promoteVerifiedAuthorizations(
  publisherDomain: string,
  manifestAgentUrls: string[],
): Promise<{ promoted: number }> {
  if (manifestAgentUrls.length === 0) return { promoted: 0 };
  const result = await query(
    `UPDATE agent_publisher_authorizations
        SET source = 'adagents_json',
            last_validated = NOW()
      WHERE publisher_domain = $1
        AND source = 'aao_hosted'
        AND agent_url = ANY($2::text[])`,
    [publisherDomain.toLowerCase(), manifestAgentUrls],
  );
  return { promoted: result.rowCount ?? 0 };
}

/**
 * Inverse of `promoteVerifiedAuthorizations`. Demote any `adagents_json`
 * rows for this publisher_domain whose agent_url is in the manifest
 * back down to `aao_hosted`. Used when origin verification fails after
 * having previously succeeded.
 */
export async function demotePreviouslyVerifiedAuthorizations(
  publisherDomain: string,
  manifestAgentUrls: string[],
): Promise<{ demoted: number }> {
  if (manifestAgentUrls.length === 0) return { demoted: 0 };
  const result = await query(
    `UPDATE agent_publisher_authorizations
        SET source = 'aao_hosted',
            last_validated = NOW()
      WHERE publisher_domain = $1
        AND source = 'adagents_json'
        AND agent_url = ANY($2::text[])`,
    [publisherDomain.toLowerCase(), manifestAgentUrls],
  );
  return { demoted: result.rowCount ?? 0 };
}
