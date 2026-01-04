/**
 * Shared database operations for email contacts
 *
 * Centralizes email contact creation, domain extraction, and org matching.
 * Used by webhooks, event imports, and any other contact ingestion.
 */

import { query, getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('contacts-db');

/**
 * Input for upserting an email contact
 */
export interface EmailContactInput {
  email: string;
  displayName?: string | null;
  domain?: string; // If not provided, extracted from email
}

/**
 * Result from upserting an email contact
 */
export interface EmailContactResult {
  contactId: string;
  organizationId: string | null;
  workosUserId: string | null;
  isNew: boolean;
  email: string;
  domain: string;
  mappingStatus: 'mapped' | 'unmapped';
}

/**
 * Parse email address to extract name, email, and domain parts
 * Handles formats like "John Doe <john@example.com>" or just "john@example.com"
 */
export function parseEmailAddress(emailStr: string): {
  email: string;
  displayName: string | null;
  domain: string;
} {
  // Match: "Display Name" <email@domain> or Display Name <email@domain>
  const withBracketsMatch = emailStr.match(
    /^(?:"?([^"<]+)"?\s*)?<([^>]+@([^>]+))>$/
  );
  if (withBracketsMatch) {
    return {
      displayName: withBracketsMatch[1]?.trim() || null,
      email: withBracketsMatch[2].toLowerCase(),
      domain: withBracketsMatch[3].toLowerCase(),
    };
  }

  // Simple email without brackets: email@domain
  const simpleMatch = emailStr.match(/^([^@\s]+)@([^@\s]+)$/);
  if (simpleMatch) {
    return {
      displayName: null,
      email: emailStr.toLowerCase(),
      domain: simpleMatch[2].toLowerCase(),
    };
  }

  // Fallback: treat whole string as email
  const atIndex = emailStr.indexOf('@');
  return {
    displayName: null,
    email: emailStr.toLowerCase(),
    domain: atIndex > 0 ? emailStr.substring(atIndex + 1).toLowerCase() : '',
  };
}

/**
 * Extract domain from email address
 */
export function extractDomain(email: string): string {
  const atIndex = email.indexOf('@');
  return atIndex > 0 ? email.substring(atIndex + 1).toLowerCase() : '';
}

/**
 * Upsert an email contact - creates if new, updates last_seen if existing
 *
 * Uses INSERT ... ON CONFLICT for atomic upsert (race-condition safe).
 * Automatically:
 * - Extracts domain from email
 * - Checks for existing org membership (auto-mapping)
 * - Updates email_count and last_seen_at for existing contacts
 *
 * @param input Email contact info
 * @param incrementCount Whether to increment email_count (default true)
 */
export async function upsertEmailContact(
  input: EmailContactInput,
  incrementCount = true
): Promise<EmailContactResult> {
  const pool = getPool();
  const email = input.email.toLowerCase();
  const domain = input.domain || extractDomain(email);
  const displayName = input.displayName || null;

  // Check if they match an existing org member (for new contacts)
  let organizationId: string | null = null;
  let workosUserId: string | null = null;

  try {
    const memberResult = await pool.query(
      `SELECT om.workos_organization_id, om.workos_user_id
       FROM organization_memberships om
       WHERE om.email = $1
       LIMIT 1`,
      [email]
    );
    organizationId = memberResult.rows[0]?.workos_organization_id || null;
    workosUserId = memberResult.rows[0]?.workos_user_id || null;
  } catch (memberLookupError) {
    // Table may not exist in all environments
    logger.debug(
      { error: memberLookupError, email },
      'Org member lookup failed, proceeding with unmapped contact'
    );
  }

  // If not found via membership, try to match by verified domain
  if (!organizationId && domain) {
    try {
      const domainResult = await pool.query(
        `SELECT workos_organization_id
         FROM organization_domains
         WHERE LOWER(domain) = LOWER($1) AND verified = true
         LIMIT 1`,
        [domain]
      );
      if (domainResult.rows[0]?.workos_organization_id) {
        organizationId = domainResult.rows[0].workos_organization_id;
        logger.debug({ email, domain, organizationId }, 'Matched contact to org by domain');
      }
    } catch (domainLookupError) {
      logger.debug(
        { error: domainLookupError, domain },
        'Domain lookup failed, proceeding with unmapped contact'
      );
    }
  }

  const mappingStatus = organizationId ? 'mapped' : 'unmapped';
  const mappingSource = organizationId ? 'email_auto' : null;

  // Atomic upsert using ON CONFLICT
  // xmax = 0 indicates the row was inserted (not updated)
  const result = await pool.query<{
    id: string;
    organization_id: string | null;
    workos_user_id: string | null;
    mapping_status: 'mapped' | 'unmapped';
    is_new: boolean;
  }>(
    `INSERT INTO email_contacts (
      email, display_name, domain,
      workos_user_id, organization_id,
      mapping_status, mapping_source,
      mapped_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (email) DO UPDATE SET
      last_seen_at = NOW(),
      email_count = CASE WHEN $9 THEN email_contacts.email_count + 1 ELSE email_contacts.email_count END
    RETURNING id, organization_id, workos_user_id, mapping_status, (xmax = 0) AS is_new`,
    [
      email,
      displayName,
      domain,
      workosUserId,
      organizationId,
      mappingStatus,
      mappingSource,
      organizationId ? new Date() : null,
      incrementCount,
    ]
  );

  const row = result.rows[0];
  const isNew = row.is_new;

  if (isNew) {
    logger.info(
      {
        email,
        domain,
        contactId: row.id,
        organizationId: row.organization_id,
        mappingStatus: row.mapping_status,
        isNew: true,
      },
      'Created new email contact'
    );
  } else {
    logger.debug(
      { email, contactId: row.id, isNew: false },
      'Found existing email contact'
    );
  }

  return {
    contactId: row.id,
    organizationId: row.organization_id,
    workosUserId: row.workos_user_id,
    isNew,
    email,
    domain,
    mappingStatus: row.mapping_status,
  };
}

/**
 * Get email contact by email address
 */
export async function getEmailContactByEmail(
  email: string
): Promise<EmailContactResult | null> {
  const result = await query<{
    id: string;
    organization_id: string | null;
    workos_user_id: string | null;
    email: string;
    domain: string;
    mapping_status: 'mapped' | 'unmapped';
  }>(
    `SELECT id, organization_id, workos_user_id, email, domain, mapping_status
     FROM email_contacts WHERE email = $1`,
    [email.toLowerCase()]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    contactId: row.id,
    organizationId: row.organization_id,
    workosUserId: row.workos_user_id,
    isNew: false,
    email: row.email,
    domain: row.domain,
    mappingStatus: row.mapping_status,
  };
}

/**
 * Get email contact by ID
 */
export async function getEmailContactById(
  id: string
): Promise<EmailContactResult | null> {
  const result = await query<{
    id: string;
    organization_id: string | null;
    workos_user_id: string | null;
    email: string;
    domain: string;
    mapping_status: 'mapped' | 'unmapped';
  }>(
    `SELECT id, organization_id, workos_user_id, email, domain, mapping_status
     FROM email_contacts WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    contactId: row.id,
    organizationId: row.organization_id,
    workosUserId: row.workos_user_id,
    isNew: false,
    email: row.email,
    domain: row.domain,
    mappingStatus: row.mapping_status,
  };
}

/**
 * Upsert multiple email contacts sequentially
 * Processes contacts one at a time with incrementCount=false for bulk imports.
 * Each upsert is atomic (race-condition safe), but the batch is not transactional.
 */
export async function upsertEmailContacts(
  inputs: EmailContactInput[]
): Promise<Map<string, EmailContactResult>> {
  const results = new Map<string, EmailContactResult>();

  for (const input of inputs) {
    const result = await upsertEmailContact(input, false);
    results.set(input.email.toLowerCase(), result);
  }

  return results;
}

/**
 * Result from linking contacts by domain
 */
export interface LinkContactsByDomainResult {
  contactsLinked: number;
  contacts: Array<{
    contactId: string;
    email: string;
  }>;
}

/**
 * Link all unmapped email contacts with a specific domain to an organization.
 *
 * This should be called when a verified domain is added to an organization.
 *
 * @param domain The email domain to match (e.g., "charter.com")
 * @param organizationId The WorkOS organization ID to link contacts to
 * @param mappedBy Optional user ID of who triggered the mapping
 */
export async function linkContactsByDomain(
  domain: string,
  organizationId: string,
  mappedBy?: string
): Promise<LinkContactsByDomainResult> {
  const pool = getPool();
  const normalizedDomain = domain.toLowerCase();

  // Update all unmapped contacts with this domain
  // Using 'manual_admin' as the mapping source since domain linking is an admin action
  const updateResult = await pool.query<{
    id: string;
    email: string;
  }>(
    `UPDATE email_contacts
     SET organization_id = $1,
         mapping_status = 'mapped',
         mapping_source = 'manual_admin',
         mapped_at = NOW(),
         mapped_by_user_id = $2,
         updated_at = NOW()
     WHERE LOWER(domain) = $3
       AND mapping_status = 'unmapped'
     RETURNING id, email`,
    [organizationId, mappedBy || null, normalizedDomain]
  );

  const linkedContacts = updateResult.rows;
  const contactsLinked = linkedContacts.length;

  if (contactsLinked === 0) {
    logger.info(
      { domain: normalizedDomain, organizationId },
      'No unmapped contacts found for domain'
    );
    return { contactsLinked: 0, contacts: [] };
  }

  logger.info(
    { domain: normalizedDomain, organizationId, contactsLinked },
    'Linked contacts to organization by domain'
  );

  return {
    contactsLinked,
    contacts: linkedContacts.map(c => ({
      contactId: c.id,
      email: c.email,
    })),
  };
}
