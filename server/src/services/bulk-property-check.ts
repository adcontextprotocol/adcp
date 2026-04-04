/**
 * Bulk property check service.
 *
 * Takes mixed identifier strings (domains, bundle IDs, app store IDs),
 * auto-detects types, looks up against both the catalog and legacy registry,
 * and returns a verdict per identifier.
 */

import { CatalogDatabase } from '../db/catalog-db.js';
import { PropertyDatabase } from '../db/property-db.js';
import { normalizeIdentifier } from './identifier-normalization.js';
import { query } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('bulk-property-check');

// ─── Types ───────────────────────────────────────────────────────

export type Verdict = 'ready' | 'known' | 'ad_infra' | 'unknown';

export interface BulkCheckEntry {
  input: string;
  identifier: { type: string; value: string } | null;
  verdict: Verdict;
  classification: string | null;
  source: string | null;
  property_rid: string | null;
  action: string;
}

export interface BulkCheckResult {
  summary: {
    total: number;
    ready: number;
    known: number;
    ad_infra: number;
    unknown: number;
    skipped: number;
  };
  entries: BulkCheckEntry[];
}

// ─── Identifier Parsing ─────────────────────────────────────────

const COMMON_TLDS = new Set([
  'com', 'org', 'net', 'io', 'tv', 'me', 'co', 'app', 'dev', 'ai',
  'us', 'uk', 'de', 'fr', 'jp', 'cn', 'ru', 'br', 'in', 'au',
  'ca', 'nl', 'es', 'it', 'se', 'no', 'fi', 'dk', 'pl', 'at',
  'ch', 'be', 'pt', 'ie', 'nz', 'za', 'mx', 'ar', 'cl', 'kr',
]);

const STORE_TYPE_MAP: Record<string, string> = {
  'GOOGLE_PLAY_STORE': 'android_package',
  'APPLE_APP_STORE': 'ios_bundle',
  'ROKU': 'roku_store_id',
  'SAMSUNG': 'samsung_app_id',
  'AMAZON': 'fire_tv_asin',
};

export function parseIdentifier(raw: string): { type: string; value: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // CSV format: STORE_TYPE,identifier
  if (trimmed.includes(',')) {
    const comma = trimmed.indexOf(',');
    const storeType = trimmed.substring(0, comma).trim().toUpperCase();
    const value = trimmed.substring(comma + 1).trim();
    const mappedType = STORE_TYPE_MAP[storeType];
    if (mappedType && value) {
      // Numeric Apple App Store IDs
      if (storeType === 'APPLE_APP_STORE' && /^\d+$/.test(value)) {
        return { type: 'apple_app_store_id', value };
      }
      return { type: mappedType, value };
    }
  }

  // Purely numeric → Apple App Store ID
  if (/^\d+$/.test(trimmed)) {
    return { type: 'apple_app_store_id', value: trimmed };
  }

  // Reverse-DNS pattern where first segment is a TLD → app bundle
  const segments = trimmed.split('.');
  if (segments.length >= 2 && COMMON_TLDS.has(segments[0].toLowerCase())) {
    return { type: 'android_package', value: trimmed.toLowerCase() };
  }

  // Contains a dot → domain (strip protocol/path if present)
  if (trimmed.includes('.')) {
    return { type: 'domain', value: trimmed };
  }

  return null;
}

// ─── Action text per verdict ────────────────────────────────────

const ACTION_TEXT: Record<Verdict, string> = {
  ready: 'Supports agent-based transactions',
  known: 'In catalog \u2014 publish adagents.json to enable',
  ad_infra: 'Ad infrastructure \u2014 excluded from direct buys',
  unknown: 'Not in registry',
};

// ─── Service ────────────────────────────────────────────────────

const catalogDb = new CatalogDatabase();
const propertyDb = new PropertyDatabase();

export class BulkPropertyCheckService {
  async check(rawLines: string[]): Promise<BulkCheckResult> {
    const entries: BulkCheckEntry[] = [];
    const parsed: Array<{ index: number; type: string; value: string }> = [];
    let skipped = 0;

    // Step 1: Parse and normalize identifiers
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      const id = parseIdentifier(raw);
      if (!id) {
        skipped++;
        continue;
      }

      const norm = normalizeIdentifier(id.type, id.value);
      parsed.push({ index: entries.length, type: norm.type, value: norm.value });
      entries.push({
        input: raw.trim(),
        identifier: { type: norm.type, value: norm.value },
        verdict: 'unknown',
        classification: null,
        source: null,
        property_rid: null,
        action: ACTION_TEXT.unknown,
      });
    }

    if (parsed.length === 0) {
      return {
        summary: { total: rawLines.length, ready: 0, known: 0, ad_infra: 0, unknown: 0, skipped },
        entries,
      };
    }

    // Step 2: Batch lookup against catalog identifiers
    const lookupInput = parsed.map(p => ({ type: p.type, value: p.value }));
    const catalogResults = await catalogDb.batchLookupIdentifiers(lookupInput);

    // Step 3: For unmatched, check catalog_facts for classifications
    const unmatched: string[] = [];
    for (const p of parsed) {
      const key = `${p.type}:${p.value}`;
      if (!catalogResults.has(key)) {
        unmatched.push(key);
      }
    }
    const classificationResults = await catalogDb.batchGetClassifications(unmatched);

    // Step 4: Check legacy registry for domains with adagents.json
    const domains = parsed
      .filter(p => p.type === 'domain')
      .map(p => p.value);
    const registryResults = domains.length > 0
      ? await propertyDb.checkDomainsInRegistry(domains)
      : new Map<string, string>();

    // Step 5: Assign verdicts
    for (const p of parsed) {
      const entry = entries[p.index];
      const key = `${p.type}:${p.value}`;

      const catalogMatch = catalogResults.get(key);
      const classification = classificationResults.get(key);
      const registrySource = p.type === 'domain' ? registryResults.get(p.value) : undefined;

      if (catalogMatch) {
        entry.property_rid = catalogMatch.property_rid;
        entry.classification = catalogMatch.classification;
        entry.source = catalogMatch.source;

        if (catalogMatch.classification === 'ad_infra' || catalogMatch.classification === 'publisher_mask' || catalogMatch.classification === 'network') {
          entry.verdict = 'ad_infra';
        } else if (registrySource) {
          entry.verdict = 'ready';
        } else {
          entry.verdict = 'known';
        }
      } else if (classification) {
        entry.classification = classification;
        if (classification === 'ad_infra' || classification === 'publisher_mask' || classification === 'network') {
          entry.verdict = 'ad_infra';
        }
      } else if (registrySource) {
        // In legacy registry but not catalog (rare — pre-migration properties)
        entry.source = registrySource;
        entry.verdict = 'ready';
      }

      entry.action = ACTION_TEXT[entry.verdict];
    }

    // Step 6: Compute summary
    const summary = {
      total: rawLines.length,
      ready: 0,
      known: 0,
      ad_infra: 0,
      unknown: 0,
      skipped,
    };
    for (const e of entries) {
      summary[e.verdict]++;
    }

    // Step 7: Enqueue "known" domains for adagents.json crawling
    const toCrawl = entries
      .filter(e => e.verdict === 'known' && e.identifier?.type === 'domain')
      .map(e => e.identifier!);
    if (toCrawl.length > 0) {
      this.enqueueCrawl(toCrawl).catch(err => {
        logger.warn({ err, count: toCrawl.length }, 'Failed to enqueue crawl');
      });
    }

    return { summary, entries };
  }

  private async enqueueCrawl(identifiers: Array<{ type: string; value: string }>): Promise<void> {
    if (identifiers.length === 0) return;
    const types = identifiers.map(i => i.type);
    const values = identifiers.map(i => i.value);
    await query(
      `INSERT INTO catalog_crawl_queue (identifier_type, identifier_value)
       SELECT unnest($1::text[]), unnest($2::text[])
       ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
      [types, values]
    );
  }

  async saveReport(result: BulkCheckResult): Promise<string> {
    const row = await query<{ id: string }>(
      `INSERT INTO bulk_check_reports (results) VALUES ($1) RETURNING id`,
      [JSON.stringify(result)]
    );
    return row.rows[0].id;
  }

  async getReport(id: string): Promise<BulkCheckResult | null> {
    const row = await query<{ results: unknown }>(
      `SELECT results FROM bulk_check_reports WHERE id = $1 AND expires_at > NOW()`,
      [id]
    );
    if (!row.rows[0]) return null;
    return row.rows[0].results as BulkCheckResult;
  }
}
