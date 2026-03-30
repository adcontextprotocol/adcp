/**
 * Catalog Seed Service — bulk import of property graph data.
 *
 * Designed for the Scope3 bootstrap: import ~100K+ classified properties,
 * ad-infra domain lists, and identifier links from JSONL format.
 *
 * Seed format (JSONL, one record per line):
 *
 * Property:
 *   {"type":"property","identifiers":[{"type":"domain","value":"nytimes.com"}],"classification":"property"}
 *
 * Classification:
 *   {"type":"classification","identifier":{"type":"domain","value":"flashtalking.net"},"classification":"ad_infra"}
 *
 * Link (identifiers that belong to the same property):
 *   {"type":"link","identifiers":[{"type":"ios_bundle","value":"com.cnn.iphone"},{"type":"apple_app_store_id","value":"331786748"}]}
 */

import { getClient } from '../db/client.js';
import { uuidv7 } from '../db/uuid.js';
import { normalizeIdentifier } from './identifier-normalization.js';
import { createLogger } from '../logger.js';
import type { PoolClient } from 'pg';

const logger = createLogger('catalog-seed');

// ─── Types ───────────────────────────────────────────────────────────────────

interface SeedProperty {
  type: 'property';
  identifiers: Array<{ type: string; value: string }>;
  classification: string;
}

interface SeedClassification {
  type: 'classification';
  identifier: { type: string; value: string };
  classification: string;
  reason?: string;
}

interface SeedLink {
  type: 'link';
  identifiers: Array<{ type: string; value: string }>;
}

type SeedRecord = SeedProperty | SeedClassification | SeedLink;

// ─── Import ──────────────────────────────────────────────────────────────────

export interface SeedResult {
  total_records: number;
  properties_created: number;
  identifiers_linked: number;
  classifications_recorded: number;
  skipped: number;
  errors: number;
}

const BATCH_SIZE = 1000;

/**
 * Import seed data from an array of JSONL lines.
 * Processes in batches of 1000 records per transaction.
 */
export async function importSeedData(
  lines: string[],
  actor: string = 'system:scope3_seed'
): Promise<SeedResult> {
  const result: SeedResult = {
    total_records: lines.length,
    properties_created: 0,
    identifiers_linked: 0,
    classifications_recorded: 0,
    skipped: 0,
    errors: 0,
  };

  // Parse all records first
  const records: SeedRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      result.errors++;
    }
  }

  // Process in batches
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchResult = await processBatch(batch, actor);
    result.properties_created += batchResult.properties_created;
    result.identifiers_linked += batchResult.identifiers_linked;
    result.classifications_recorded += batchResult.classifications_recorded;
    result.skipped += batchResult.skipped;
    result.errors += batchResult.errors;

    if ((i + BATCH_SIZE) % 10000 === 0) {
      logger.info(`Seed progress: ${i + BATCH_SIZE}/${records.length} records processed`);
    }
  }

  logger.info(`Seed complete: ${JSON.stringify(result)}`);
  return result;
}

async function processBatch(
  records: SeedRecord[],
  actor: string
): Promise<Omit<SeedResult, 'total_records'>> {
  const result = {
    properties_created: 0,
    identifiers_linked: 0,
    classifications_recorded: 0,
    skipped: 0,
    errors: 0,
  };

  const client = await getClient();
  try {
    await client.query('BEGIN');

    for (const record of records) {
      try {
        switch (record.type) {
          case 'property':
            await processPropertyRecord(client, record, actor, result);
            break;
          case 'classification':
            await processClassificationRecord(client, record, actor, result);
            break;
          case 'link':
            await processLinkRecord(client, record, actor, result);
            break;
          default:
            result.skipped++;
        }
      } catch (err) {
        result.errors++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    result.errors += records.length;
    logger.error(`Batch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.release();
  }

  return result;
}

async function processPropertyRecord(
  client: PoolClient,
  record: SeedProperty,
  actor: string,
  result: Omit<SeedResult, 'total_records'>
): Promise<void> {
  if (!record.identifiers || record.identifiers.length === 0) {
    result.skipped++;
    return;
  }

  const normalized = record.identifiers.map(i => normalizeIdentifier(i.type, i.value));
  const primaryIdent = normalized[0];

  // Check if any identifier already exists
  const existingCheck = await client.query(
    `SELECT ci.property_rid FROM catalog_identifiers ci
     WHERE (ci.identifier_type, ci.identifier_value) IN (${
       normalized.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ')
     })
     LIMIT 1`,
    normalized.flatMap(n => [n.type, n.value])
  );

  let propertyRid: string;

  if (existingCheck.rows.length > 0) {
    // Property exists — add any new identifiers to it
    propertyRid = existingCheck.rows[0].property_rid;
  } else {
    // Create new property
    propertyRid = uuidv7();
    await client.query(
      `INSERT INTO catalog_properties (property_rid, classification, source, status, created_by)
       VALUES ($1, $2, 'contributed', 'active', $3)`,
      [propertyRid, record.classification || 'property', actor]
    );
    result.properties_created++;
  }

  // Link all identifiers
  for (const norm of normalized) {
    await client.query(
      `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
       VALUES ($1, $2, $3, $4, 'data_partner', 'strong')
       ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
      [uuidv7(), propertyRid, norm.type, norm.value]
    );
    result.identifiers_linked++;
  }

  // Record fact
  await client.query(
    `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
     VALUES ($1, 'identity', 'identifier', $2, 'exists', $3, 'data_partner', 'strong', $4)`,
    [uuidv7(), `${primaryIdent.type}:${primaryIdent.value}`, propertyRid, actor]
  );
}

async function processClassificationRecord(
  client: PoolClient,
  record: SeedClassification,
  actor: string,
  result: Omit<SeedResult, 'total_records'>
): Promise<void> {
  const norm = normalizeIdentifier(record.identifier.type, record.identifier.value);

  await client.query(
    `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
     VALUES ($1, 'classification', 'identifier', $2, 'classified_as', $3, 'data_partner', 'strong', $4)`,
    [uuidv7(), `${norm.type}:${norm.value}`, record.classification, actor]
  );

  result.classifications_recorded++;
}

async function processLinkRecord(
  client: PoolClient,
  record: SeedLink,
  actor: string,
  result: Omit<SeedResult, 'total_records'>
): Promise<void> {
  if (!record.identifiers || record.identifiers.length < 2) {
    result.skipped++;
    return;
  }

  const normalized = record.identifiers.map(i => normalizeIdentifier(i.type, i.value));

  // Find existing property for any of these identifiers
  const existingCheck = await client.query(
    `SELECT ci.property_rid FROM catalog_identifiers ci
     WHERE (ci.identifier_type, ci.identifier_value) IN (${
       normalized.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ')
     })
     LIMIT 1`,
    normalized.flatMap(n => [n.type, n.value])
  );

  let propertyRid: string;

  if (existingCheck.rows.length > 0) {
    propertyRid = existingCheck.rows[0].property_rid;
  } else {
    // Create a new property for this link group
    propertyRid = uuidv7();
    await client.query(
      `INSERT INTO catalog_properties (property_rid, classification, source, status, created_by)
       VALUES ($1, 'property', 'contributed', 'active', $2)`,
      [propertyRid, actor]
    );
    result.properties_created++;
  }

  // Link all identifiers to the same property
  for (const norm of normalized) {
    await client.query(
      `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
       VALUES ($1, $2, $3, $4, 'data_partner', 'strong')
       ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
      [uuidv7(), propertyRid, norm.type, norm.value]
    );
    result.identifiers_linked++;
  }

  // Record linking fact
  const identStrs = normalized.map(n => `${n.type}:${n.value}`);
  await client.query(
    `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
     VALUES ($1, 'linking', 'identifier', $2, 'same_property_as', $3, 'data_partner', 'strong', $4)`,
    [uuidv7(), identStrs[0], identStrs.slice(1).join(','), actor]
  );
}
