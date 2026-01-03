/**
 * Entity Linker Service
 *
 * Links extracted entities from articles to the organizations database.
 * Auto-creates prospect organizations when new companies are detected.
 */

import { query } from '../../db/client.js';
import { logger } from '../../logger.js';
import type { ExtractedEntity } from './content-curator.js';

/**
 * Result of attempting to link an entity to an organization
 */
export interface EntityLinkResult {
  entity_name: string;
  entity_type: string;
  organization_id: string | null;
  matched_via: 'exact' | 'alias' | 'domain' | 'created' | null;
}

/**
 * Trending entity from the trending_entities view
 */
export interface TrendingEntity {
  entity_type: string;
  entity_name: string;
  organization_id: string | null;
  organization_name: string | null;
  article_count: number;
  total_mentions: number;
}

/**
 * Normalize entity name for matching
 * - Lowercase
 * - Remove common suffixes (Inc., LLC, Corp., etc.)
 * - Trim whitespace
 */
function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+(inc\.?|llc\.?|corp\.?|corporation|company|co\.?|ltd\.?|limited)$/i, '')
    .replace(/[.,]/g, '')
    .trim();
}

/**
 * Try to match an entity to an existing organization
 */
async function matchEntityToOrganization(
  entityName: string,
  entityType: string
): Promise<EntityLinkResult> {
  const normalized = normalizeEntityName(entityName);

  // Only match companies to organizations
  if (entityType !== 'company') {
    return {
      entity_name: entityName,
      entity_type: entityType,
      organization_id: null,
      matched_via: null,
    };
  }

  // 1. Try exact match on organizations.name (normalized)
  const exactMatch = await query<{ workos_organization_id: string }>(
    `SELECT workos_organization_id FROM organizations
     WHERE LOWER(TRIM(name)) = $1
     LIMIT 1`,
    [normalized]
  );

  if (exactMatch.rows[0]) {
    return {
      entity_name: entityName,
      entity_type: entityType,
      organization_id: exactMatch.rows[0].workos_organization_id,
      matched_via: 'exact',
    };
  }

  // 2. Try alias match
  const aliasMatch = await query<{ organization_id: string }>(
    `SELECT organization_id FROM entity_aliases
     WHERE LOWER(alias) = $1 AND organization_id IS NOT NULL
     LIMIT 1`,
    [normalized]
  );

  if (aliasMatch.rows[0]) {
    return {
      entity_name: entityName,
      entity_type: entityType,
      organization_id: aliasMatch.rows[0].organization_id,
      matched_via: 'alias',
    };
  }

  // 3. Try domain-based match (if entity name looks like a domain or company with known domain)
  // Extract potential domain from entity name
  const domainMatch = await query<{ workos_organization_id: string }>(
    `SELECT od.workos_organization_id FROM organization_domains od
     WHERE LOWER(od.domain) LIKE '%' || $1 || '%'
        OR $1 LIKE '%' || LOWER(REPLACE(od.domain, '.', '')) || '%'
     LIMIT 1`,
    [normalized.replace(/\s+/g, '')]
  );

  if (domainMatch.rows[0]) {
    return {
      entity_name: entityName,
      entity_type: entityType,
      organization_id: domainMatch.rows[0].workos_organization_id,
      matched_via: 'domain',
    };
  }

  // No match found
  return {
    entity_name: entityName,
    entity_type: entityType,
    organization_id: null,
    matched_via: null,
  };
}

/**
 * Get or create an organization for an entity
 * Auto-creates prospect organizations for new companies
 */
async function getOrCreateOrganization(
  entityName: string,
  entityType: string
): Promise<EntityLinkResult> {
  // First try to match existing
  const matchResult = await matchEntityToOrganization(entityName, entityType);

  if (matchResult.organization_id) {
    return matchResult;
  }

  // Only auto-create for companies
  if (entityType !== 'company') {
    return matchResult;
  }

  // Auto-create a prospect organization
  const normalized = normalizeEntityName(entityName);

  // Generate a unique ID for this auto-created org
  // Use a prefix to identify auto-created orgs
  const autoOrgId = `auto_entity_${normalized.replace(/[^a-z0-9]/g, '_')}`;

  try {
    const result = await query<{ workos_organization_id: string }>(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET updated_at = NOW()
       RETURNING workos_organization_id`,
      [autoOrgId, entityName]
    );

    if (result.rows[0]) {
      logger.info(
        { entityName, orgId: result.rows[0].workos_organization_id },
        'Auto-created prospect organization from entity extraction'
      );

      return {
        entity_name: entityName,
        entity_type: entityType,
        organization_id: result.rows[0].workos_organization_id,
        matched_via: 'created',
      };
    }
  } catch (error) {
    logger.warn(
      { error, entityName },
      'Failed to auto-create organization for entity'
    );
  }

  return matchResult;
}

/**
 * Save extracted entities for an article to the database
 * Links entities to organizations where possible
 */
export async function saveArticleEntities(
  knowledgeId: number,
  entities: ExtractedEntity[]
): Promise<void> {
  if (!entities || entities.length === 0) {
    return;
  }

  logger.debug(
    { knowledgeId, entityCount: entities.length },
    'Saving article entities'
  );

  // First, delete existing entities for this article (in case of re-processing)
  await query(
    `DELETE FROM article_entities WHERE knowledge_id = $1`,
    [knowledgeId]
  );

  // Process each entity
  for (const entity of entities) {
    try {
      // Try to link to organization (auto-creates for new companies)
      const linkResult = await getOrCreateOrganization(entity.name, entity.type);

      // Insert the entity
      await query(
        `INSERT INTO article_entities (
          knowledge_id, entity_type, entity_name, entity_normalized,
          organization_id, mention_count, is_primary, confidence, context_snippet
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (knowledge_id, entity_type, entity_normalized) DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          mention_count = EXCLUDED.mention_count,
          is_primary = EXCLUDED.is_primary,
          context_snippet = EXCLUDED.context_snippet`,
        [
          knowledgeId,
          entity.type,
          entity.name,
          normalizeEntityName(entity.name),
          linkResult.organization_id,
          entity.mention_count,
          entity.is_primary,
          0.8, // Default confidence from Claude extraction
          entity.context.substring(0, 500),
        ]
      );
    } catch (error) {
      logger.warn(
        { error, knowledgeId, entityName: entity.name },
        'Failed to save entity'
      );
    }
  }
}

/**
 * Get trending companies from the last N days
 */
export async function getTrendingCompanies(
  days: number = 7,
  limit: number = 10
): Promise<TrendingEntity[]> {
  const result = await query<TrendingEntity>(
    `SELECT
      entity_type,
      entity_normalized as entity_name,
      organization_id,
      o.name as organization_name,
      COUNT(DISTINCT ae.knowledge_id) as article_count,
      SUM(ae.mention_count) as total_mentions
    FROM article_entities ae
    JOIN addie_knowledge k ON k.id = ae.knowledge_id
    LEFT JOIN organizations o ON o.workos_organization_id = ae.organization_id
    WHERE k.fetch_status = 'success'
      AND k.publication_status != 'rejected'
      AND k.created_at > NOW() - INTERVAL '1 day' * $1
      AND ae.entity_type = 'company'
    GROUP BY ae.entity_type, ae.entity_normalized, ae.organization_id, o.name
    ORDER BY article_count DESC, total_mentions DESC
    LIMIT $2`,
    [days, limit]
  );

  return result.rows;
}

/**
 * Get articles mentioning a specific entity
 */
export async function getArticlesByEntity(
  entityName: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ id: number; title: string; source_url: string; published_at: Date | null; quality_score: number | null }[]> {
  const normalized = normalizeEntityName(entityName);

  const result = await query<{
    id: number;
    title: string;
    source_url: string;
    published_at: Date | null;
    quality_score: number | null;
  }>(
    `SELECT k.id, k.title, k.source_url, k.published_at, k.quality_score
     FROM addie_knowledge k
     JOIN article_entities ae ON ae.knowledge_id = k.id
     WHERE ae.entity_normalized = $1
       AND k.fetch_status = 'success'
       AND k.publication_status != 'rejected'
     ORDER BY k.published_at DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    [normalized, limit, offset]
  );

  return result.rows;
}

/**
 * Get articles for a specific organization
 */
export async function getArticlesByOrganization(
  organizationId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ id: number; title: string; source_url: string; published_at: Date | null; quality_score: number | null; entity_name: string }[]> {
  const result = await query<{
    id: number;
    title: string;
    source_url: string;
    published_at: Date | null;
    quality_score: number | null;
    entity_name: string;
  }>(
    `SELECT DISTINCT ON (k.id)
       k.id, k.title, k.source_url, k.published_at, k.quality_score, ae.entity_name
     FROM addie_knowledge k
     JOIN article_entities ae ON ae.knowledge_id = k.id
     WHERE ae.organization_id = $1
       AND k.fetch_status = 'success'
       AND k.publication_status != 'rejected'
     ORDER BY k.id, k.published_at DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    [organizationId, limit, offset]
  );

  return result.rows;
}

/**
 * Add an entity alias for better matching
 */
export async function addEntityAlias(
  alias: string,
  canonicalName: string,
  organizationId: string | null,
  createdBy: string = 'system'
): Promise<void> {
  await query(
    `INSERT INTO entity_aliases (alias, canonical_name, organization_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (alias) DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name,
       organization_id = EXCLUDED.organization_id`,
    [alias.toLowerCase(), canonicalName, organizationId, createdBy]
  );
}
