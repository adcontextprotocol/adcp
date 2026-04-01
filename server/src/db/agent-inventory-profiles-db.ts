import { query } from './client.js';
import { PROPERTY_COUNT_WEIGHT, TMP_BOOST } from '../registry-sync/scoring.js';

const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentInventoryProfile {
  agent_url: string;
  channels: string[];
  property_types: string[];
  markets: string[];
  categories: string[];
  tags: string[];
  delivery_types: string[];
  format_ids: unknown[];
  property_count: number;
  publisher_count: number;
  has_tmp: boolean;
  category_taxonomy: string | null;
  updated_at: Date;
}

export interface ProfileUpsertInput {
  agent_url: string;
  channels?: string[];
  property_types?: string[];
  markets?: string[];
  categories?: string[];
  tags?: string[];
  delivery_types?: string[];
  format_ids?: unknown[];
  property_count?: number;
  publisher_count?: number;
  has_tmp?: boolean;
  category_taxonomy?: string | null;
}

export interface SearchQuery {
  channels?: string[];
  property_types?: string[];
  markets?: string[];
  categories?: string[];
  tags?: string[];
  delivery_types?: string[];
  has_tmp?: boolean;
  min_properties?: number;
  cursor?: string;
  limit?: number;
}

export interface SearchResult {
  agent_url: string;
  channels: string[];
  property_types: string[];
  markets: string[];
  categories: string[];
  tags: string[];
  delivery_types: string[];
  format_ids: unknown[];
  property_count: number;
  publisher_count: number;
  has_tmp: boolean;
  category_taxonomy: string | null;
  relevance_score: number;
  matched_filters: string[];
  updated_at: Date;
}

export interface SearchResponse {
  results: SearchResult[];
  cursor: string | null;
  has_more: boolean;
}

// ─── Filter dimensions for relevance scoring ─────────────────────────────────

const ARRAY_FILTER_COLUMNS = [
  'channels', 'property_types', 'markets', 'categories', 'tags', 'delivery_types',
] as const;

type ArrayFilterColumn = typeof ARRAY_FILTER_COLUMNS[number];

// ─── Database ────────────────────────────────────────────────────────────────

export class AgentInventoryProfilesDatabase {

  async upsertProfile(input: ProfileUpsertInput): Promise<void> {
    await query(
      `INSERT INTO agent_inventory_profiles (
        agent_url, channels, property_types, markets, categories, tags,
        delivery_types, format_ids, property_count, publisher_count, has_tmp,
        category_taxonomy, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (agent_url) DO UPDATE SET
        channels = EXCLUDED.channels,
        property_types = EXCLUDED.property_types,
        markets = EXCLUDED.markets,
        categories = EXCLUDED.categories,
        tags = EXCLUDED.tags,
        delivery_types = EXCLUDED.delivery_types,
        format_ids = EXCLUDED.format_ids,
        property_count = EXCLUDED.property_count,
        publisher_count = EXCLUDED.publisher_count,
        has_tmp = EXCLUDED.has_tmp,
        category_taxonomy = EXCLUDED.category_taxonomy,
        updated_at = NOW()`,
      [
        input.agent_url,
        input.channels ?? [],
        input.property_types ?? [],
        input.markets ?? [],
        input.categories ?? [],
        input.tags ?? [],
        input.delivery_types ?? [],
        JSON.stringify(input.format_ids ?? []),
        input.property_count ?? 0,
        input.publisher_count ?? 0,
        input.has_tmp ?? false,
        input.category_taxonomy ?? null,
      ]
    );
  }

  async upsertProfiles(inputs: ProfileUpsertInput[]): Promise<void> {
    if (inputs.length === 0) return;

    // Batch upserts in a single transaction to avoid N round-trips
    const { getClient } = await import('./client.js');
    const client = await getClient();
    try {
      await client.query('BEGIN');
      for (const input of inputs) {
        const sql = `INSERT INTO agent_inventory_profiles (
          agent_url, channels, property_types, markets, categories, tags,
          delivery_types, format_ids, property_count, publisher_count, has_tmp,
          category_taxonomy, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT (agent_url) DO UPDATE SET
          channels = EXCLUDED.channels,
          property_types = EXCLUDED.property_types,
          markets = EXCLUDED.markets,
          categories = EXCLUDED.categories,
          tags = EXCLUDED.tags,
          delivery_types = EXCLUDED.delivery_types,
          format_ids = EXCLUDED.format_ids,
          property_count = EXCLUDED.property_count,
          publisher_count = EXCLUDED.publisher_count,
          has_tmp = EXCLUDED.has_tmp,
          category_taxonomy = EXCLUDED.category_taxonomy,
          updated_at = NOW()`;
        await client.query(sql, [
          input.agent_url,
          input.channels ?? [],
          input.property_types ?? [],
          input.markets ?? [],
          input.categories ?? [],
          input.tags ?? [],
          input.delivery_types ?? [],
          JSON.stringify(input.format_ids ?? []),
          input.property_count ?? 0,
          input.publisher_count ?? 0,
          input.has_tmp ?? false,
          input.category_taxonomy ?? null,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getProfile(agentUrl: string): Promise<AgentInventoryProfile | null> {
    const result = await query<AgentInventoryProfile>(
      'SELECT * FROM agent_inventory_profiles WHERE agent_url = $1',
      [agentUrl]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Search profiles with structured filters. OR within each filter dimension,
   * AND across dimensions. Returns results ranked by relevance score.
   *
   * Uses shared scoring constants from registry-sync/scoring.ts — must match client-side AgentIndex.
   *
   * Known limitation: cursor pagination on computed scores means rows can be
   * skipped or duplicated if profiles are updated between pages.
   */
  async search(searchQuery: SearchQuery): Promise<SearchResponse> {
    const limit = Math.min(Math.max(1, searchQuery.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Track which filter dimensions are active for relevance scoring
    const activeFilters: ArrayFilterColumn[] = [];
    const scoreParts: string[] = [];

    // Array overlap filters (OR within dimension, AND across dimensions)
    for (const col of ARRAY_FILTER_COLUMNS) {
      const values = searchQuery[col];
      if (values && values.length > 0) {
        activeFilters.push(col);
        conditions.push(`${col} && $${paramIdx}`);
        params.push(values);

        // Score contribution: 1 if overlaps, 0 if not (for matched_filters tracking)
        scoreParts.push(`CASE WHEN ${col} && $${paramIdx} THEN 1 ELSE 0 END`);
        paramIdx++;
      }
    }

    // Boolean filter
    if (searchQuery.has_tmp !== undefined) {
      conditions.push(`has_tmp = $${paramIdx}`);
      params.push(searchQuery.has_tmp);
      paramIdx++;
    }

    // Minimum property count
    if (searchQuery.min_properties !== undefined && searchQuery.min_properties > 0) {
      conditions.push(`property_count >= $${paramIdx}`);
      params.push(searchQuery.min_properties);
      paramIdx++;
    }

    // Relevance score computation
    const totalDimensions = activeFilters.length || 1;
    const matchedDimensionsSql = scoreParts.length > 0
      ? `(${scoreParts.join(' + ')})`
      : '0';
    // Scoring constants shared with client-side AgentIndex (registry-sync/scoring.ts)
    const relevanceScore = `(${matchedDimensionsSql}::float / ${totalDimensions} + ln(property_count + 1) * ${PROPERTY_COUNT_WEIGHT} + CASE WHEN has_tmp THEN ${TMP_BOOST} ELSE 0 END)`;

    // Build matched_filters array for the response
    const matchedFiltersSql = activeFilters.length > 0
      ? `ARRAY[${activeFilters.map((col, i) => {
          // The param index for each array filter is i+1 (1-indexed)
          return `CASE WHEN ${col} && $${i + 1} THEN '${col}' ELSE NULL END`;
        }).join(', ')}]`
      : "'{}'::text[]";

    // Cursor pagination: (score, agent_url) keyset
    if (searchQuery.cursor) {
      conditions.push(`(${relevanceScore}, agent_url) < ($${paramIdx}, $${paramIdx + 1})`);
      const [cursorScore, cursorUrl] = decodeCursor(searchQuery.cursor);
      params.push(cursorScore, cursorUrl);
      paramIdx += 2;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT *,
        ${relevanceScore} AS relevance_score,
        array_remove(${matchedFiltersSql}, NULL) AS matched_filters
      FROM agent_inventory_profiles
      ${whereClause}
      ORDER BY ${relevanceScore} DESC, agent_url ASC
      LIMIT $${paramIdx}`;
    params.push(limit + 1);

    const result = await query<SearchResult>(sql, params);

    const hasMore = result.rows.length > limit;
    const results = hasMore ? result.rows.slice(0, limit) : result.rows;
    const lastResult = results[results.length - 1];
    const cursor = lastResult
      ? encodeCursor(lastResult.relevance_score, lastResult.agent_url)
      : null;

    return { results, cursor, has_more: hasMore };
  }

  async deleteStaleProfiles(currentAgentUrls: string[]): Promise<number> {
    if (currentAgentUrls.length === 0) {
      // Delete all profiles if no agents are current
      const result = await query('DELETE FROM agent_inventory_profiles');
      return result.rowCount ?? 0;
    }

    const result = await query(
      'DELETE FROM agent_inventory_profiles WHERE agent_url != ALL($1)',
      [currentAgentUrls]
    );
    return result.rowCount ?? 0;
  }
}

// ─── Cursor encoding ─────────────────────────────────────────────────────────

function encodeCursor(score: number, agentUrl: string): string {
  return Buffer.from(`${score}:${agentUrl}`).toString('base64url');
}

function decodeCursor(cursor: string): [number, string] {
  const decoded = Buffer.from(cursor, 'base64url').toString();
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) throw new Error('Invalid cursor format');
  const score = parseFloat(decoded.substring(0, colonIdx));
  const url = decoded.substring(colonIdx + 1);
  if (isNaN(score)) throw new Error('Invalid cursor score');
  return [score, url];
}
