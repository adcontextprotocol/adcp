/**
 * Catalog Database — core data layer for the property catalog.
 *
 * The catalog is a fact graph: identifiers in, property_rids out.
 * Every assertion has source, confidence, and timestamp.
 * Auto-linking only for authoritative/strong evidence.
 * Medium/weak assertions create facts but not identifier links
 * without corroboration from a second independent source.
 */

import { query, getClient } from './client.js';
import { uuidv7 } from './uuid.js';
import { normalizeIdentifier } from '../services/identifier-normalization.js';
import { lookupTrancoRank, isTrancoLoaded } from '../services/tranco-ingestion.js';
import type { PoolClient } from 'pg';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CatalogProperty {
  property_rid: string;
  property_id: string | null;
  classification: string;
  source: string;
  status: string;
  adagents_url: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  source_updated_at: Date;
}

export interface CatalogIdentifier {
  id: string;
  property_rid: string;
  identifier_type: string;
  identifier_value: string;
  evidence: string;
  confidence: string;
  disputed: boolean;
  created_at: Date;
}

export interface CatalogFact {
  fact_id: string;
  fact_type: string;
  subject_type: string;
  subject_value: string;
  predicate: string;
  object_value: string | null;
  source: string;
  confidence: string;
  actor: string;
  provenance_type: string | null;
  provenance_context: string | null;
  superseded_by: string | null;
  created_at: Date;
  expires_at: Date | null;
}

export interface ResolveInput {
  type: string;
  value: string;
}

export interface Provenance {
  type: string;
  context?: string;
}

export type ResolveMode = 'resolve' | 'lookup';

export interface ResolvedEntry {
  identifier: { type: string; value: string };
  property_rid: string | null;
  classification: string;
  status: 'existing' | 'created' | 'excluded';
  source: string | null;
}

export interface ResolveResult {
  resolved: ResolvedEntry[];
  summary: {
    total: number;
    resolved: number;
    created: number;
    excluded: number;
    not_found: number;
  };
  server_timestamp: string;
}

export interface ListFilters {
  classification?: string;
  source?: string;
  status?: string;
  identifier_type?: string;
  search?: string;
  min_resolves?: number;
  active_since?: string;
  limit?: number;
  cursor?: string;
}

export interface PropertyWithIdentifiers extends CatalogProperty {
  identifiers: CatalogIdentifier[];
}

export interface ActivityEntry {
  member_id: string;
  provenance_type: string;
  resolve_count: number;
  last_resolved: Date;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AUTO_LINK_CONFIDENCE = new Set(['authoritative', 'strong']);

// ─── Database Class ──────────────────────────────────────────────────────────

export class CatalogDatabase {

  // ═══════════════════════════════════════════════════════════════════════════
  // Resolve — the primary operation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve identifiers to property_rids.
   * In 'resolve' mode: creates missing properties, logs activity.
   * In 'lookup' mode: returns existing only, no creates, no logging.
   */
  async resolveIdentifiers(
    identifiers: ResolveInput[],
    mode: ResolveMode,
    memberId: string,
    provenance: Provenance
  ): Promise<ResolveResult> {
    const normalized = identifiers.map(({ type, value }) => normalizeIdentifier(type, value));
    const results: ResolvedEntry[] = [];
    let created = 0;
    let excluded = 0;
    let notFound = 0;

    // Batch lookup: find all existing identifiers
    const existing = await this.batchLookupIdentifiers(
      normalized.map(n => ({ type: n.type, value: n.value }))
    );

    // Check aliases for any found rids
    const aliasMap = await this.batchResolveAliases(
      [...new Set(
        Array.from(existing.values())
          .filter(e => e !== null)
          .map(e => e!.property_rid)
      )]
    );

    // For unknown identifiers, batch-fetch classifications from catalog_facts
    const unknownNorms = normalized.filter(n => !existing.has(`${n.type}:${n.value}`));
    const classifications = unknownNorms.length > 0
      ? await this.batchGetClassifications(unknownNorms.map(n => `${n.type}:${n.value}`))
      : new Map<string, string>();

    // Collect entries to batch-create
    const toCreate: Array<{
      propertyRid: string;
      identifierType: string;
      identifierValue: string;
      memberId: string;
      provenance: Provenance;
    }> = [];

    // First pass: classify all results without DB writes
    for (const norm of normalized) {
      const key = `${norm.type}:${norm.value}`;
      const found = existing.get(key);

      if (found) {
        const canonicalRid = aliasMap.get(found.property_rid) ?? found.property_rid;
        results.push({
          identifier: { type: norm.type, value: norm.value },
          property_rid: canonicalRid,
          classification: found.classification,
          status: 'existing',
          source: found.source,
        });
      } else if (mode === 'resolve') {
        const classification = classifications.get(`${norm.type}:${norm.value}`) ?? null;

        if (classification === 'ad_infra' || classification === 'publisher_mask') {
          results.push({
            identifier: { type: norm.type, value: norm.value },
            property_rid: null,
            classification,
            status: 'excluded',
            source: null,
          });
          excluded++;
        } else {
          const rid = uuidv7();
          toCreate.push({
            propertyRid: rid,
            identifierType: norm.type,
            identifierValue: norm.value,
            memberId,
            provenance,
          });
          results.push({
            identifier: { type: norm.type, value: norm.value },
            property_rid: rid,
            classification: 'property',
            status: 'created',
            source: 'contributed',
          });
          created++;
        }
      } else {
        const classification = classifications.get(`${norm.type}:${norm.value}`) ?? null;
        results.push({
          identifier: { type: norm.type, value: norm.value },
          property_rid: null,
          classification: classification ?? 'unknown',
          status: 'excluded',
          source: classification ? 'data_partner' : null,
        });
        if (classification === 'ad_infra' || classification === 'publisher_mask') {
          excluded++;
        } else {
          notFound++;
        }
      }
    }

    // Second pass: batch writes in a single transaction
    const client = mode === 'resolve' ? await getClient() : null;
    try {
      if (client) await client.query('BEGIN');

      // Batch create all new properties + identifiers + facts
      if (client && toCreate.length > 0) {
        await this.batchCreatePropertiesWithIdentifiers(client, toCreate);

        // Batch Tranco corroboration for new domains
        if (isTrancoLoaded()) {
          const trancoFacts: Array<Omit<CatalogFact, 'fact_id' | 'created_at' | 'superseded_by'>> = [];
          for (const entry of toCreate) {
            if (entry.identifierType === 'domain') {
              const tranco = lookupTrancoRank(entry.identifierValue);
              if (tranco.rank !== null) {
                trancoFacts.push({
                  fact_type: 'corroboration',
                  subject_type: 'identifier',
                  subject_value: `domain:${entry.identifierValue}`,
                  predicate: 'has_tranco_rank',
                  object_value: String(tranco.rank),
                  source: 'web_crawl',
                  confidence: tranco.in_top_10k ? 'strong' : tranco.in_top_100k ? 'medium' : 'weak',
                  actor: 'pipeline:tranco',
                  provenance_type: null,
                  provenance_context: null,
                  expires_at: null,
                });
              }
            }
          }
          if (trancoFacts.length > 0) {
            await this.insertFacts(trancoFacts);
          }
        }
      }

      // Batch log activity for all resolved/created entries
      if (mode === 'resolve' && client) {
        const activityEntries = results
          .filter(r => r.property_rid !== null)
          .map(r => ({
            property_rid: r.property_rid!,
            member_id: memberId,
            provenance_type: provenance.type,
            provenance_context: provenance.context ?? null,
          }));

        if (activityEntries.length > 0) {
          await this.batchInsertActivity(client, activityEntries);
        }
      }

      if (client) await client.query('COMMIT');
    } catch (err) {
      if (client) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (client) client.release();
    }

    const resolved = results.filter(r => r.status === 'existing').length;

    return {
      resolved: results,
      summary: {
        total: identifiers.length,
        resolved: resolved + created,
        created,
        excluded,
        not_found: notFound,
      },
      server_timestamp: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read operations
  // ═══════════════════════════════════════════════════════════════════════════

  async getProperty(propertyRid: string): Promise<PropertyWithIdentifiers | null> {
    const propResult = await query<CatalogProperty>(
      'SELECT * FROM catalog_properties WHERE property_rid = $1',
      [propertyRid]
    );
    if (propResult.rows.length === 0) return null;

    const identResult = await query<CatalogIdentifier>(
      'SELECT * FROM catalog_identifiers WHERE property_rid = $1 AND disputed = FALSE ORDER BY created_at',
      [propertyRid]
    );

    return { ...propResult.rows[0], identifiers: identResult.rows };
  }

  async listProperties(filters: ListFilters): Promise<{ properties: CatalogProperty[]; next_cursor: string | null; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Default: active properties only
    conditions.push(`cp.status = $${paramIdx++}`);
    params.push(filters.status ?? 'active');

    if (filters.classification) {
      conditions.push(`cp.classification = $${paramIdx++}`);
      params.push(filters.classification);
    }

    if (filters.source) {
      conditions.push(`cp.source = $${paramIdx++}`);
      params.push(filters.source);
    }

    if (filters.search) {
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_identifiers ci
        WHERE ci.property_rid = cp.property_rid
          AND ci.identifier_value ILIKE $${paramIdx++} ESCAPE '\\'
          AND ci.disputed = FALSE
      )`);
      params.push(`%${filters.search.replace(/[%_\\]/g, '\\$&')}%`);
    }

    if (filters.identifier_type) {
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_identifiers ci
        WHERE ci.property_rid = cp.property_rid
          AND ci.identifier_type = $${paramIdx++}
          AND ci.disputed = FALSE
      )`);
      params.push(filters.identifier_type);
    }

    if (filters.cursor) {
      conditions.push(`cp.property_rid > $${paramIdx++}`);
      params.push(filters.cursor);
    }

    const limit = Math.min(filters.limit ?? 100, 1000);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<{ count: string }>(
      `SELECT count(*) FROM catalog_properties cp ${where}`,
      params
    );

    params.push(limit);
    const result = await query<CatalogProperty>(
      `SELECT cp.* FROM catalog_properties cp ${where}
       ORDER BY cp.property_rid
       LIMIT $${paramIdx}`,
      params
    );

    const rows = result.rows;
    const nextCursor = rows.length === limit ? rows[rows.length - 1].property_rid : null;

    return {
      properties: rows,
      next_cursor: nextCursor,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async syncProperties(since: string, limit: number = 10000): Promise<{
    entries: CatalogProperty[];
    server_timestamp: string;
    next_cursor: string | null;
  }> {
    const result = await query<CatalogProperty>(
      `SELECT * FROM catalog_properties
       WHERE updated_at > $1 AND classification = 'property' AND status = 'active'
       ORDER BY updated_at, property_rid
       LIMIT $2`,
      [since, limit]
    );

    const rows = result.rows;
    const nextCursor = rows.length === limit ? rows[rows.length - 1].property_rid : null;

    return {
      entries: rows,
      server_timestamp: new Date().toISOString(),
      next_cursor: nextCursor,
    };
  }

  async getPropertyActivity(propertyRid: string): Promise<{
    distinct_members: number;
    last_resolved: Date | null;
    by_member: ActivityEntry[];
  }> {
    const result = await query<ActivityEntry>(
      `SELECT
        member_id,
        provenance_type,
        count(*)::int AS resolve_count,
        max(resolved_at) AS last_resolved
       FROM catalog_activity
       WHERE property_rid = $1
       GROUP BY member_id, provenance_type
       ORDER BY max(resolved_at) DESC`,
      [propertyRid]
    );

    const distinctMembers = new Set(result.rows.map(r => r.member_id)).size;
    const lastResolved = result.rows.length > 0 ? result.rows[0].last_resolved : null;

    return {
      distinct_members: distinctMembers,
      last_resolved: lastResolved,
      by_member: result.rows,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Facts
  // ═══════════════════════════════════════════════════════════════════════════

  async insertFact(fact: Omit<CatalogFact, 'fact_id' | 'created_at' | 'superseded_by'>): Promise<string> {
    const factId = uuidv7();
    await query(
      `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor, provenance_type, provenance_context, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [factId, fact.fact_type, fact.subject_type, fact.subject_value, fact.predicate, fact.object_value, fact.source, fact.confidence, fact.actor, fact.provenance_type, fact.provenance_context, fact.expires_at]
    );
    return factId;
  }

  async insertFacts(facts: Array<Omit<CatalogFact, 'fact_id' | 'created_at' | 'superseded_by'>>): Promise<string[]> {
    if (facts.length === 0) return [];

    const client = await getClient();
    const ids: string[] = [];
    try {
      await client.query('BEGIN');
      for (const fact of facts) {
        const factId = uuidv7();
        ids.push(factId);
        await client.query(
          `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor, provenance_type, provenance_context, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [factId, fact.fact_type, fact.subject_type, fact.subject_value, fact.predicate, fact.object_value, fact.source, fact.confidence, fact.actor, fact.provenance_type, fact.provenance_context, fact.expires_at]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return ids;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Identifier linking
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Link an identifier to a property.
   * Auto-links only for authoritative/strong evidence.
   * Medium/weak evidence creates a fact and checks for corroboration
   * before creating the actual link.
   */
  async linkIdentifier(
    propertyRid: string,
    identifierType: string,
    identifierValue: string,
    evidence: string,
    confidence: string,
    actor: string
  ): Promise<{ linked: boolean; fact_id: string; reason?: string }> {
    const norm = normalizeIdentifier(identifierType, identifierValue);

    // Always record the fact
    const factId = await this.insertFact({
      fact_type: 'linking',
      subject_type: 'identifier',
      subject_value: `${norm.type}:${norm.value}`,
      predicate: 'has_identifier',
      object_value: propertyRid,
      source: evidence,
      confidence,
      actor,
      provenance_type: null,
      provenance_context: null,
      expires_at: null,
    });

    // Check for existing link (might be to a different property)
    const existing = await query<CatalogIdentifier>(
      `SELECT * FROM catalog_identifiers WHERE identifier_type = $1 AND identifier_value = $2`,
      [norm.type, norm.value]
    );

    if (existing.rows.length > 0) {
      const existingLink = existing.rows[0];
      if (existingLink.property_rid === propertyRid) {
        return { linked: true, fact_id: factId, reason: 'already_linked' };
      }
      // Conflict: identifier already linked to different property.
      // Only authoritative evidence can override.
      if (confidence !== 'authoritative') {
        return { linked: false, fact_id: factId, reason: 'conflict_with_existing_link' };
      }
      // Authoritative override: update the link
      await query(
        `UPDATE catalog_identifiers SET property_rid = $1, evidence = $2, confidence = $3, disputed = FALSE WHERE id = $4`,
        [propertyRid, evidence, confidence, existingLink.id]
      );
      return { linked: true, fact_id: factId, reason: 'override_existing' };
    }

    // Auto-link for high confidence
    if (AUTO_LINK_CONFIDENCE.has(confidence)) {
      const id = uuidv7();
      await query(
        `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
        [id, propertyRid, norm.type, norm.value, evidence, confidence]
      );
      return { linked: true, fact_id: factId };
    }

    // Medium/weak: check corroboration (a different actor already asserted this)
    const corroboration = await query<{ count: string }>(
      `SELECT count(*) FROM catalog_facts
       WHERE fact_type = 'linking'
         AND subject_value = $1
         AND object_value = $2
         AND actor != $3
         AND superseded_by IS NULL`,
      [`${norm.type}:${norm.value}`, propertyRid, actor]
    );

    if (parseInt(corroboration.rows[0].count, 10) > 0) {
      // Corroborated — create the link
      const id = uuidv7();
      await query(
        `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
        [id, propertyRid, norm.type, norm.value, evidence, confidence]
      );
      return { linked: true, fact_id: factId, reason: 'corroborated' };
    }

    return { linked: false, fact_id: factId, reason: 'awaiting_corroboration' };
  }

  /**
   * Suspend an identifier link (mark as disputed).
   */
  async suspendIdentifierLink(identifierType: string, identifierValue: string, reason: string, actor: string): Promise<boolean> {
    const norm = normalizeIdentifier(identifierType, identifierValue);
    const result = await query(
      `UPDATE catalog_identifiers SET disputed = TRUE WHERE identifier_type = $1 AND identifier_value = $2 AND disputed = FALSE`,
      [norm.type, norm.value]
    );

    if (result.rowCount && result.rowCount > 0) {
      await this.insertFact({
        fact_type: 'linking',
        subject_type: 'identifier',
        subject_value: `${norm.type}:${norm.value}`,
        predicate: 'link_suspended',
        object_value: reason,
        source: 'dispute',
        confidence: 'strong',
        actor,
        provenance_type: null,
        provenance_context: null,
        expires_at: null,
      });
      return true;
    }
    return false;
  }

  /**
   * Reinstate a disputed identifier link.
   */
  async reinstateIdentifierLink(identifierType: string, identifierValue: string, actor: string): Promise<boolean> {
    const norm = normalizeIdentifier(identifierType, identifierValue);
    const result = await query(
      `UPDATE catalog_identifiers SET disputed = FALSE WHERE identifier_type = $1 AND identifier_value = $2 AND disputed = TRUE`,
      [norm.type, norm.value]
    );

    if (result.rowCount && result.rowCount > 0) {
      await this.insertFact({
        fact_type: 'linking',
        subject_type: 'identifier',
        subject_value: `${norm.type}:${norm.value}`,
        predicate: 'link_reinstated',
        object_value: null,
        source: 'dispute_resolution',
        confidence: 'strong',
        actor,
        provenance_type: null,
        provenance_context: null,
        expires_at: null,
      });
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Merging
  // ═══════════════════════════════════════════════════════════════════════════

  async mergeProperties(canonicalRid: string, aliasRid: string, evidence: string, actor: string): Promise<void> {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Move all identifiers from alias to canonical
      await client.query(
        `UPDATE catalog_identifiers SET property_rid = $1 WHERE property_rid = $2`,
        [canonicalRid, aliasRid]
      );

      // Create alias
      await client.query(
        `INSERT INTO catalog_aliases (alias_rid, canonical_rid, evidence, actor) VALUES ($1, $2, $3, $4)`,
        [aliasRid, canonicalRid, evidence, actor]
      );

      // Mark old property as removed
      await client.query(
        `UPDATE catalog_properties SET status = 'removed', updated_at = NOW() WHERE property_rid = $1`,
        [aliasRid]
      );

      // Log fact
      await client.query(
        `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
         VALUES ($1, 'linking', 'property_rid', $2, 'merged_into', $3, $4, 'strong', $5)`,
        [uuidv7(), aliasRid, canonicalRid, evidence, actor]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════════════

  async batchLookupIdentifiers(
    identifiers: Array<{ type: string; value: string }>
  ): Promise<Map<string, { property_rid: string; classification: string; source: string } | null>> {
    if (identifiers.length === 0) return new Map();

    const types = identifiers.map(i => i.type);
    const values = identifiers.map(i => i.value);

    const result = await query<{
      identifier_type: string;
      identifier_value: string;
      property_rid: string;
      classification: string;
      source: string;
    }>(
      `SELECT ci.identifier_type, ci.identifier_value, ci.property_rid, cp.classification, cp.source
       FROM catalog_identifiers ci
       JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
       WHERE ci.disputed = FALSE
         AND (ci.identifier_type, ci.identifier_value) IN (
           SELECT unnest($1::text[]), unnest($2::text[])
         )`,
      [types, values]
    );

    const map = new Map<string, { property_rid: string; classification: string; source: string } | null>();
    for (const row of result.rows) {
      map.set(`${row.identifier_type}:${row.identifier_value}`, {
        property_rid: row.property_rid,
        classification: row.classification,
        source: row.source,
      });
    }
    return map;
  }

  private async batchResolveAliases(rids: string[]): Promise<Map<string, string>> {
    if (rids.length === 0) return new Map();

    const result = await query<{ alias_rid: string; canonical_rid: string }>(
      `SELECT alias_rid, canonical_rid FROM catalog_aliases WHERE alias_rid = ANY($1)`,
      [rids]
    );

    const map = new Map<string, string>();
    for (const row of result.rows) {
      map.set(row.alias_rid, row.canonical_rid);
    }
    return map;
  }

  /**
   * Batch classification lookup — single query for all identifiers.
   * Returns the highest-confidence classification for each identifier value.
   */
  async batchGetClassifications(
    identifierValues: string[]
  ): Promise<Map<string, string>> {
    if (identifierValues.length === 0) return new Map();

    const result = await query<{ subject_value: string; object_value: string }>(
      `SELECT DISTINCT ON (subject_value) subject_value, object_value
       FROM catalog_facts
       WHERE fact_type = 'classification'
         AND subject_type = 'identifier'
         AND subject_value = ANY($1)
         AND predicate = 'classified_as'
         AND superseded_by IS NULL
       ORDER BY subject_value,
         CASE confidence
           WHEN 'authoritative' THEN 1
           WHEN 'strong' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'weak' THEN 4
         END,
         created_at DESC`,
      [identifierValues]
    );

    const map = new Map<string, string>();
    for (const row of result.rows) {
      map.set(row.subject_value, row.object_value);
    }
    return map;
  }

  /**
   * Batch create properties with identifiers and facts.
   * Uses multi-row INSERT for each table instead of per-identifier queries.
   */
  private async batchCreatePropertiesWithIdentifiers(
    client: PoolClient,
    entries: Array<{
      propertyRid: string;
      identifierType: string;
      identifierValue: string;
      memberId: string;
      provenance: Provenance;
    }>
  ): Promise<void> {
    if (entries.length === 0) return;

    // Batch insert properties
    const propValues: any[] = [];
    const propPlaceholders: string[] = [];
    let propIdx = 1;
    for (const e of entries) {
      propPlaceholders.push(`($${propIdx++}, 'property', 'contributed', 'active', $${propIdx++})`);
      propValues.push(e.propertyRid, e.memberId);
    }
    await client.query(
      `INSERT INTO catalog_properties (property_rid, classification, source, status, created_by)
       VALUES ${propPlaceholders.join(', ')}`,
      propValues
    );

    // Batch insert identifiers
    const identValues: any[] = [];
    const identPlaceholders: string[] = [];
    let identIdx = 1;
    for (const e of entries) {
      identPlaceholders.push(`($${identIdx++}, $${identIdx++}, $${identIdx++}, $${identIdx++}, 'member_resolve', 'medium')`);
      identValues.push(uuidv7(), e.propertyRid, e.identifierType, e.identifierValue);
    }
    await client.query(
      `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
       VALUES ${identPlaceholders.join(', ')}`,
      identValues
    );

    // Batch insert facts
    const factValues: any[] = [];
    const factPlaceholders: string[] = [];
    let factIdx = 1;
    for (const e of entries) {
      factPlaceholders.push(`($${factIdx++}, 'identity', 'identifier', $${factIdx++}, 'exists', $${factIdx++}, 'member_resolve', 'medium', $${factIdx++}, $${factIdx++}, $${factIdx++})`);
      factValues.push(
        uuidv7(),
        `${e.identifierType}:${e.identifierValue}`,
        e.propertyRid,
        e.memberId,
        e.provenance.type,
        e.provenance.context ?? null
      );
    }
    await client.query(
      `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor, provenance_type, provenance_context)
       VALUES ${factPlaceholders.join(', ')}`,
      factValues
    );
  }

  private async batchInsertActivity(
    client: PoolClient,
    entries: Array<{ property_rid: string; member_id: string; provenance_type: string; provenance_context: string | null }>
  ): Promise<void> {
    if (entries.length === 0) return;

    const values: any[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const entry of entries) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      values.push(uuidv7(), entry.property_rid, entry.member_id, entry.provenance_type, entry.provenance_context);
    }

    await client.query(
      `INSERT INTO catalog_activity (id, property_rid, member_id, provenance_type, provenance_context)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  // ─── Public Registry ────────────────────────────────────────────────────────

  async getPropertiesForRegistry(options: {
    search?: string;
    limit?: number;
    offset?: number;
    source?: string;
  }): Promise<Array<{
    property_rid: string;
    source: string;
    verified: boolean;
    identifiers: Array<{ type: string; value: string }>;
  }>> {
    const limit = Math.min(options.limit || 100, 5000);
    const offset = options.offset || 0;
    const conditions: string[] = [
      `cp.classification = 'property'`,
      `cp.status = 'active'`,
    ];
    const params: any[] = [];
    let idx = 1;

    if (options.search) {
      const escaped = options.search.replace(/[%_\\]/g, '\\$&');
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_identifiers ci2
        WHERE ci2.property_rid = cp.property_rid
          AND ci2.disputed = FALSE
          AND ci2.identifier_value ILIKE $${idx++} ESCAPE '\\'
      )`);
      params.push(`%${escaped}%`);
    }

    if (options.source) {
      conditions.push(`cp.source = $${idx++}`);
      params.push(options.source);
    }

    const where = conditions.join(' AND ');

    const result = await query<{
      property_rid: string;
      source: string;
      adagents_url: string | null;
      identifiers: Array<{ type: string; value: string }>;
    }>(
      `SELECT cp.property_rid, cp.source, cp.adagents_url,
              COALESCE(
                json_agg(json_build_object('type', ci.identifier_type, 'value', ci.identifier_value)
                ORDER BY ci.identifier_type, ci.identifier_value)
                FILTER (WHERE ci.id IS NOT NULL),
                '[]'::json
              ) AS identifiers
       FROM catalog_properties cp
       JOIN catalog_identifiers ci ON ci.property_rid = cp.property_rid AND ci.disputed = FALSE
       WHERE ${where}
       GROUP BY cp.property_rid, cp.source, cp.adagents_url
       ORDER BY cp.property_rid
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    return result.rows.map(row => ({
      property_rid: row.property_rid,
      source: row.source,
      verified: row.source === 'authoritative',
      identifiers: row.identifiers,
    }));
  }

  async getRegistryStats(search?: string): Promise<Record<string, number>> {
    const conditions: string[] = [
      `cp.classification = 'property'`,
      `cp.status = 'active'`,
    ];
    const params: any[] = [];
    let idx = 1;

    if (search) {
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_identifiers ci
        WHERE ci.property_rid = cp.property_rid
          AND ci.disputed = FALSE
          AND ci.identifier_value ILIKE $${idx++} ESCAPE '\\'
      )`);
      params.push(`%${escaped}%`);
    }

    const where = conditions.join(' AND ');

    const result = await query<{ source: string; count: number }>(
      `SELECT cp.source, COUNT(DISTINCT cp.property_rid)::int AS count
       FROM catalog_properties cp
       WHERE ${where}
       GROUP BY cp.source`,
      params
    );

    const stats: Record<string, number> = { total: 0, authoritative: 0, enriched: 0, contributed: 0 };
    for (const row of result.rows) {
      stats[row.source] = row.count;
      stats.total += row.count;
    }
    return stats;
  }
}
