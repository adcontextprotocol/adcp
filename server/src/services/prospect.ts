/**
 * Prospect management service
 *
 * Centralized logic for creating and managing prospects.
 * Used by both the admin API and Addie tools.
 */

import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import { WorkOS, DomainDataState } from '@workos-inc/node';
import { resolveOrgByDomain } from '../db/domain-resolution-db.js';
import { researchDomain, trackBackground } from './brand-enrichment.js';
import { linkDomain, unlinkDomainAndReselectPrimary } from '../db/organization-domains-db.js';
import { enrichOrganization } from './enrichment.js';
import { isLushaConfigured } from './lusha.js';
import { COMPANY_TYPE_VALUES } from '../config/company-types.js';
import { VALID_REVENUE_TIERS } from '../db/organization-db.js';
import {
  getCompanyDomain,
  getGoogleEmailAliases,
  isFreeEmailDomain,
  normalizeEmail,
} from '../utils/email-domain.js';
import { validateEmail } from '../middleware/validation.js';
import {
  assertClaimableBrandDomain,
  canonicalizeBrandDomain,
} from './identifier-normalization.js';

// Initialize WorkOS client if configured
const workos =
  process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
    ? new WorkOS(process.env.WORKOS_API_KEY, {
        clientId: process.env.WORKOS_CLIENT_ID,
      })
    : null;

const logger = createLogger('prospect-service');

const VALID_PROSPECT_STATUSES = [
  'prospect', 'contacted', 'responded', 'interested',
  'negotiating', 'joined', 'converted', 'declined', 'disqualified'
] as const;

function normalizeExplicitDomain(domain: string): string {
  const normalized = canonicalizeBrandDomain(domain);
  assertClaimableBrandDomain(normalized);
  if (isFreeEmailDomain(normalized)) {
    throw new Error(`"${normalized}" is a free email provider domain and can't be claimed as a prospect domain.`);
  }
  return normalized;
}

function inferBusinessDomainFromContactEmail(email: string | undefined): string | null {
  if (!email) return null;
  const companyDomain = getCompanyDomain(email);
  if (!companyDomain) return null;

  const normalized = canonicalizeBrandDomain(companyDomain);
  try {
    assertClaimableBrandDomain(normalized);
  } catch {
    return null;
  }
  return normalized;
}

function normalizeProspectDomain(input: CreateProspectInput): string | null {
  if (input.is_personal) return null;
  const explicit = input.domain?.trim();
  if (explicit) return normalizeExplicitDomain(explicit);
  return inferBusinessDomainFromContactEmail(input.prospect_contact_email);
}

function prospectDomainTrust(input: CreateProspectInput): {
  source: 'import' | 'backfill_prospect_contact';
  verified: boolean;
  workosState: DomainDataState;
} {
  if (input.domain?.trim()) {
    return { source: 'import', verified: true, workosState: DomainDataState.Verified };
  }
  return {
    source: 'backfill_prospect_contact',
    verified: false,
    workosState: DomainDataState.Pending,
  };
}

export interface CreateProspectInput {
  name: string;
  domain?: string;
  is_personal?: boolean;
  company_type?: string;
  prospect_status?: string;
  prospect_source?: string;
  prospect_notes?: string;
  prospect_contact_name?: string;
  prospect_contact_email?: string;
  prospect_contact_title?: string;
  prospect_next_action?: string;
  prospect_next_action_date?: string;
  prospect_owner?: string;
}

export interface CreateProspectResult {
  success: boolean;
  organization?: {
    workos_organization_id: string;
    name: string;
    company_type?: string;
    email_domain?: string;
    is_personal?: boolean;
    prospect_status: string;
  };
  error?: string;
  alreadyExists?: boolean;
}

/**
 * Create a new prospect organization
 *
 * This creates both a WorkOS organization and a local database record.
 * Auto-enriches the organization if a domain is provided.
 */
export async function createProspect(
  input: CreateProspectInput
): Promise<CreateProspectResult> {
  const pool = getPool();

  if (!workos) {
    return {
      success: false,
      error: 'WorkOS not configured',
    };
  }

  const name = input.name.trim();
  const isPersonal = input.is_personal === true;
  const contactEmail = input.prospect_contact_email
    ? normalizeEmail(input.prospect_contact_email)
    : null;

  if (isPersonal && !validateEmail(contactEmail).valid) {
    return {
      success: false,
      error: 'A valid contact email is required to create an individual prospect',
    };
  }

  // Validate prospect_status if provided
  if (input.prospect_status && !VALID_PROSPECT_STATUSES.includes(input.prospect_status as typeof VALID_PROSPECT_STATUSES[number])) {
    return {
      success: false,
      error: `Invalid prospect_status. Must be one of: ${VALID_PROSPECT_STATUSES.join(', ')}`,
    };
  }

  let normalizedDomain: string | null;
  try {
    normalizedDomain = normalizeProspectDomain(input);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid domain',
    };
  }

  if (!isPersonal && !normalizedDomain) {
    return {
      success: false,
      error: 'A valid business domain or business contact email is required to create a prospect',
    };
  }

  if (isPersonal && contactEmail) {
    const emailAliases = [contactEmail, ...getGoogleEmailAliases(contactEmail)];
    const existingPersonal = await pool.query<{
      workos_organization_id: string;
      name: string;
      company_type: string | null;
      prospect_status: string | null;
      is_personal: boolean;
    }>(
      `SELECT DISTINCT o.workos_organization_id, o.name, o.company_type,
              o.prospect_status, o.is_personal
       FROM organizations o
       LEFT JOIN organization_memberships om
         ON om.workos_organization_id = o.workos_organization_id
       LEFT JOIN users u ON u.workos_user_id = om.workos_user_id
       LEFT JOIN membership_invites mi
         ON mi.workos_organization_id = o.workos_organization_id
       WHERE o.is_personal = true
         AND (
           LOWER(TRIM(o.prospect_contact_email)) = ANY($1::text[])
           OR LOWER(TRIM(om.email)) = ANY($1::text[])
           OR LOWER(TRIM(u.email)) = ANY($1::text[])
           OR LOWER(TRIM(mi.contact_email)) = ANY($1::text[])
         )
       ORDER BY o.workos_organization_id
       LIMIT 2`,
      [emailAliases],
    );

    if (existingPersonal.rows.length > 1) {
      return {
        success: false,
        alreadyExists: true,
        error: `Multiple individual workspaces are associated with ${contactEmail}; resolve the duplicate before sending an invite`,
      };
    }

    if (existingPersonal.rows.length === 1) {
      const existing = existingPersonal.rows[0];
      return {
        success: false,
        alreadyExists: true,
        organization: {
          ...existing,
          company_type: existing.company_type ?? undefined,
          prospect_status: existing.prospect_status ?? '',
        },
        error: `An individual workspace for ${contactEmail} already exists`,
      };
    }
  }

  // Check if domain resolves to an existing organization (exact, alias, sub-brand, or redirect)
  if (normalizedDomain) {
    const resolved = await resolveOrgByDomain(normalizedDomain);
    if (resolved) {
      const isAlias = resolved.matchedDomain !== normalizedDomain;
      logger.info({ domain: normalizedDomain, matchedDomain: resolved.matchedDomain, method: resolved.method, orgId: resolved.orgId },
        isAlias ? 'Domain resolves to existing org via alias' : 'Domain already tracked');

      // Fetch actual org details so callers have useful info
      const orgRow = await pool.query<{ name: string; prospect_status: string | null }>(
        `SELECT name, prospect_status FROM organizations WHERE workos_organization_id = $1`,
        [resolved.orgId]
      );
      const orgName = orgRow.rows[0]?.name ?? resolved.matchedDomain;
      return {
        success: false,
        error: isAlias ? `Domain resolves to ${orgName} via ${resolved.method}` : `Domain already tracked (${orgName})`,
        alreadyExists: true,
        organization: {
          workos_organization_id: resolved.orgId,
          name: orgRow.rows[0]?.name ?? resolved.matchedDomain,
          prospect_status: orgRow.rows[0]?.prospect_status ?? '',
        },
      };
    }
  }

  // Check for existing organization with same name
  const existing = isPersonal
    ? { rows: [] }
    : await pool.query(
        `SELECT workos_organization_id, name FROM organizations
         WHERE LOWER(name) = LOWER($1) AND is_personal = false`,
        [name]
      );

  if (existing.rows.length > 0) {
    return {
      success: false,
      error: `Organization "${existing.rows[0].name}" already exists`,
      alreadyExists: true,
      organization: existing.rows[0],
    };
  }

  try {
    const domainTrust = normalizedDomain ? prospectDomainTrust(input) : null;
    // Create organization in WorkOS
    const workosOrg = await workos.organizations.createOrganization(
      normalizedDomain && domainTrust
        ? { name, domainData: [{ domain: normalizedDomain, state: domainTrust.workosState }] }
        : { name },
    );

    logger.info(
      { orgId: workosOrg.id, name, domain: normalizedDomain },
      'Created WorkOS organization for prospect'
    );

    // Create local database record
    const result = await pool.query(
      `INSERT INTO organizations (
        workos_organization_id,
        name,
        company_type,
        email_domain,
        prospect_status,
        prospect_source,
        prospect_notes,
        prospect_contact_name,
        prospect_contact_email,
        prospect_contact_title,
        prospect_next_action,
        prospect_next_action_date,
        prospect_owner,
        is_personal,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
      RETURNING workos_organization_id, name, company_type, email_domain, prospect_status, is_personal`,
      [
        workosOrg.id,
        name,
        input.company_type || null,
        null,
        input.prospect_status || 'prospect',
        input.prospect_source || 'manual',
        input.prospect_notes || null,
        input.prospect_contact_name || null,
        contactEmail,
        input.prospect_contact_title || null,
        input.prospect_next_action || null,
        input.prospect_next_action_date || null,
        input.prospect_owner || null,
        isPersonal,
      ]
    );

    const org = result.rows[0];

    if (normalizedDomain && domainTrust) {
      const linkResult = await linkDomain({
        orgId: workosOrg.id,
        domain: normalizedDomain,
        source: domainTrust.source,
        verified: domainTrust.verified,
        isPrimary: true,
      });
      if (linkResult.conflictOrgId) {
        await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [workosOrg.id]);
        return {
          success: false,
          alreadyExists: true,
          error: `Domain ${normalizedDomain} is already linked to another organization (${linkResult.conflictOrgId})`,
        };
      }

      const bgPromise = researchDomain(normalizedDomain, { org_id: workosOrg.id }).catch((err) => {
        logger.warn(
          { err, domain: normalizedDomain, orgId: workosOrg.id },
          'Background research failed for new prospect'
        );
      });
      trackBackground(bgPromise);
    }

    return {
      success: true,
      organization: { ...org, email_domain: normalizedDomain || undefined },
    };
  } catch (error) {
    logger.error({ err: error, name }, 'Error creating prospect');

    // Handle WorkOS domain errors
    if (error instanceof Error && error.message.includes('domain')) {
      return {
        success: false,
        error: `Domain error: ${error.message}`,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if a prospect with the given name already exists
 */
export async function prospectExists(name: string): Promise<{
  exists: boolean;
  organization?: { workos_organization_id: string; name: string };
}> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT workos_organization_id, name FROM organizations
     WHERE LOWER(name) = LOWER($1) AND is_personal = false`,
    [name.trim()]
  );

  if (result.rows.length > 0) {
    return { exists: true, organization: result.rows[0] };
  }
  return { exists: false };
}

// ============================================================================
// Update prospect
// ============================================================================

/**
 * Fields that can be updated on a prospect/account.
 * Used by both the API PUT handler and Addie's update_prospect tool.
 */
export const UPDATABLE_PROSPECT_FIELDS = [
  'name',
  'company_type',
  'company_types',
  'revenue_tier',
  'prospect_status',
  'prospect_source',
  'prospect_owner',
  'prospect_notes',
  'prospect_contact_name',
  'prospect_contact_email',
  'prospect_contact_title',
  'prospect_next_action',
  'prospect_next_action_date',
  'disqualification_reason',
  'interest_level',
  'email_domain',
] as const;

export interface UpdateProspectInput {
  /** Fields to update — keys must be from UPDATABLE_PROSPECT_FIELDS */
  fields: Record<string, unknown>;
  /** How to handle notes: 'overwrite' replaces, 'append' adds with timestamp */
  notesMode?: 'overwrite' | 'append';
  /** Who is setting the interest_level (for attribution tracking) */
  interestLevelSetBy?: string;
  /** Whether to trigger enrichment when domain changes */
  triggerEnrichment?: boolean;
}

export interface UpdateProspectResult {
  success: boolean;
  updated?: Record<string, unknown>;
  fieldsChanged?: string[];
  error?: string;
}

export async function updateProspect(
  orgId: string,
  input: UpdateProspectInput,
): Promise<UpdateProspectResult> {
  const pool = getPool();

  // Verify org exists (and get existing notes for append mode)
  const existing = await pool.query<{ name: string; prospect_notes: string | null; email_domain: string | null }>(
    `SELECT name, prospect_notes, email_domain FROM organizations WHERE workos_organization_id = $1`,
    [orgId]
  );

  if (existing.rows.length === 0) {
    return { success: false, error: `Organization not found: ${orgId}` };
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  const fieldsChanged: string[] = [];
  let paramIndex = 1;
  let domainToLink: string | null | undefined;
  const previousDomain = existing.rows[0].email_domain?.trim().toLowerCase() || null;

  const updatableSet = new Set<string>(UPDATABLE_PROSPECT_FIELDS);
  const VALID_INTEREST_LEVELS = ['low', 'medium', 'high', 'very_high'];

  for (const [key, value] of Object.entries(input.fields)) {
    if (value === undefined) continue;

    // Validate field name against allowlist
    if (!updatableSet.has(key)) continue;

    // Validate revenue_tier values
    if (key === 'revenue_tier' && value !== null && value !== '') {
      if (!VALID_REVENUE_TIERS.includes(value as any)) {
        return { success: false, error: `Invalid revenue_tier. Must be one of: ${VALID_REVENUE_TIERS.join(', ')}` };
      }
    }

    // Validate interest_level values
    if (key === 'interest_level' && value !== null && value !== '') {
      if (!VALID_INTEREST_LEVELS.includes(value as string)) {
        return { success: false, error: `Invalid interest_level. Must be one of: ${VALID_INTEREST_LEVELS.join(', ')}` };
      }
    }

    // Special handling: company_types array syncs primary company_type
    if (key === 'company_types') {
      let typesArray = Array.isArray(value) ? value : null;
      if (typesArray) {
        typesArray = typesArray.filter((t: string) => COMPANY_TYPE_VALUES.includes(t as any));
        if (typesArray.length === 0) typesArray = null;
      }
      setClauses.push(`company_types = $${paramIndex}`);
      values.push(typesArray);
      paramIndex++;
      fieldsChanged.push('company_types');
      if (typesArray && typesArray.length > 0) {
        setClauses.push(`company_type = $${paramIndex}`);
        values.push(typesArray[0]);
        paramIndex++;
      }
      continue;
    }

    // Special handling: notes append mode
    if (key === 'prospect_notes' && input.notesMode === 'append' && value) {
      const timestamp = new Date().toISOString().split('T')[0];
      const existingNotes = existing.rows[0].prospect_notes || '';
      const newNotes = existingNotes
        ? `${existingNotes}\n\n[${timestamp}] ${value}`
        : `[${timestamp}] ${value}`;
      setClauses.push(`prospect_notes = $${paramIndex}`);
      values.push(newNotes);
      paramIndex++;
      fieldsChanged.push('prospect_notes');
      continue;
    }

    // Special handling: interest_level tracks who set it
    if (key === 'interest_level' && value) {
      setClauses.push(`interest_level = $${paramIndex}`);
      values.push(value);
      paramIndex++;
      if (input.interestLevelSetBy) {
        setClauses.push(`interest_level_set_by = $${paramIndex}`);
        values.push(input.interestLevelSetBy);
        paramIndex++;
      }
      setClauses.push(`interest_level_set_at = NOW()`);
      fieldsChanged.push('interest_level');
      continue;
    }

    if (key === 'email_domain') {
      if (value === null || value === '') {
        setClauses.push(`email_domain = $${paramIndex}`);
        values.push(null);
        paramIndex++;
        fieldsChanged.push('email_domain');
        domainToLink = null;
        continue;
      }

      if (typeof value !== 'string') {
        return { success: false, error: 'Invalid email_domain' };
      }

      try {
        domainToLink = normalizeExplicitDomain(value);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Invalid email_domain',
        };
      }
      fieldsChanged.push('email_domain');
      continue;
    }

    setClauses.push(`${key} = $${paramIndex}`);
    values.push(value === '' ? null : value);
    paramIndex++;
    fieldsChanged.push(key);
  }

  if (setClauses.length === 0 && domainToLink === undefined) {
    return { success: false, error: 'No valid fields to update' };
  }

  if (domainToLink) {
    const linkResult = await linkDomain({
      orgId,
      domain: domainToLink,
      source: 'admin_discovery',
      verified: true,
      isPrimary: true,
    });
    if (linkResult.conflictOrgId) {
      return {
        success: false,
        error: `Domain ${domainToLink} is already linked to another organization (${linkResult.conflictOrgId})`,
      };
    }
    if (previousDomain && previousDomain !== domainToLink) {
      await unlinkDomainAndReselectPrimary({ orgId, domain: previousDomain });
    }
  } else if (domainToLink === null && previousDomain) {
    await unlinkDomainAndReselectPrimary({ orgId, domain: previousDomain });
  }

  const result = setClauses.length > 0
    ? await pool.query(
        `UPDATE organizations SET ${[...setClauses, 'updated_at = NOW()'].join(', ')} WHERE workos_organization_id = $${paramIndex} RETURNING *`,
        [...values, orgId]
      )
    : await pool.query(
        `SELECT * FROM organizations WHERE workos_organization_id = $1`,
        [orgId]
      );

  if (result.rows.length === 0) {
    return { success: false, error: 'Account not found' };
  }

  // Trigger enrichment if domain changed
  if (input.triggerEnrichment && input.fields.email_domain && isLushaConfigured()) {
    trackBackground(
      enrichOrganization(orgId, input.fields.email_domain as string).catch(err => {
        logger.warn({ err, orgId }, 'Background enrichment failed after update');
      })
    );
  }

  return {
    success: true,
    updated: result.rows[0],
    fieldsChanged,
  };
}
