/**
 * Prospect management service
 *
 * Centralized logic for creating and managing prospects.
 * Used by both the admin API and Addie tools.
 */

import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import { WorkOS, DomainDataState } from '@workos-inc/node';
import { enrichOrganization } from './enrichment.js';

// Initialize WorkOS client if configured
const workos =
  process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
    ? new WorkOS(process.env.WORKOS_API_KEY, {
        clientId: process.env.WORKOS_CLIENT_ID,
      })
    : null;

const logger = createLogger('prospect-service');

export interface CreateProspectInput {
  name: string;
  domain?: string;
  company_type?: string;
  prospect_source?: string;
  prospect_notes?: string;
  prospect_contact_name?: string;
  prospect_contact_email?: string;
  prospect_contact_title?: string;
  prospect_next_action?: string;
  prospect_next_action_date?: string;
  prospect_owner?: string;
  parent_organization_id?: string;
}

export interface CreateProspectResult {
  success: boolean;
  organization?: {
    workos_organization_id: string;
    name: string;
    company_type?: string;
    email_domain?: string;
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

  // Check for existing organization with same name
  const existing = await pool.query(
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
    // Create organization in WorkOS
    const workosOrg = await workos.organizations.createOrganization({
      name,
      domainData: input.domain
        ? [{ domain: input.domain.trim(), state: DomainDataState.Verified }]
        : undefined,
    });

    logger.info(
      { orgId: workosOrg.id, name, domain: input.domain },
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
        parent_organization_id,
        is_personal,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false, NOW(), NOW())
      RETURNING workos_organization_id, name, company_type, email_domain, prospect_status`,
      [
        workosOrg.id,
        name,
        input.company_type || null,
        input.domain?.trim() || null,
        'prospect',
        input.prospect_source || 'manual',
        input.prospect_notes || null,
        input.prospect_contact_name || null,
        input.prospect_contact_email || null,
        input.prospect_contact_title || null,
        input.prospect_next_action || null,
        input.prospect_next_action_date || null,
        input.prospect_owner || null,
        input.parent_organization_id || null,
      ]
    );

    const org = result.rows[0];

    // Auto-enrich in background if domain provided
    if (input.domain) {
      enrichOrganization(workosOrg.id, input.domain.trim()).catch((err) => {
        logger.warn(
          { err, domain: input.domain, orgId: workosOrg.id },
          'Background enrichment failed for new prospect'
        );
      });
    }

    return {
      success: true,
      organization: org,
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
