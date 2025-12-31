/**
 * Addie Admin Tools
 *
 * Tools for admin users to manage prospects, organizations, and enrichment.
 * These tools are only available when the user has admin role.
 *
 * CRITICAL: All operations are restricted to admin users only.
 */

import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { getPool } from '../../db/client.js';
import {
  enrichOrganization,
  enrichDomain,
} from '../../services/enrichment.js';
import {
  getLushaClient,
  isLushaConfigured,
  mapIndustryToCompanyType,
} from '../../services/lusha.js';
import { createProspect } from '../../services/prospect.js';

/**
 * Check if user has admin privileges
 */
export function isAdmin(memberContext: MemberContext | null): boolean {
  return memberContext?.org_membership?.role === 'admin';
}

/**
 * Tool definitions for admin operations
 */
export const ADMIN_TOOLS: AddieTool[] = [
  // ============================================
  // PROSPECT MANAGEMENT
  // ============================================
  {
    name: 'add_prospect',
    description:
      'Add a new prospect organization to track. Use this when someone mentions a company we should be talking to. Requires admin access.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Company name (e.g., "Acme Corporation")',
        },
        company_type: {
          type: 'string',
          enum: ['adtech', 'agency', 'brand', 'publisher', 'other'],
          description: 'Type of company (adtech, agency, brand, publisher, or other)',
        },
        domain: {
          type: 'string',
          description: 'Company domain for enrichment (e.g., "acme.com"). Optional but helps with auto-enrichment.',
        },
        contact_name: {
          type: 'string',
          description: 'Primary contact name at the company',
        },
        contact_email: {
          type: 'string',
          description: 'Primary contact email',
        },
        notes: {
          type: 'string',
          description: 'Any notes about the prospect (e.g., how we heard about them, why they\'re relevant)',
        },
        source: {
          type: 'string',
          description: 'How we found this prospect (e.g., "slack_conversation", "referral", "conference")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_prospect',
    description:
      'Search for existing prospects by name or domain. Use this to check if a company is already in our system before adding them.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - company name or domain',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_prospect',
    description:
      'Update information about an existing prospect. Use this to add notes, change status, or update contact info.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: {
          type: 'string',
          description: 'Organization ID to update',
        },
        company_type: {
          type: 'string',
          enum: ['adtech', 'agency', 'brand', 'publisher', 'other'],
          description: 'Type of company',
        },
        status: {
          type: 'string',
          enum: ['prospect', 'contacted', 'responded', 'interested', 'negotiating', 'converted', 'declined', 'inactive'],
          description: 'Prospect status',
        },
        contact_name: {
          type: 'string',
          description: 'Primary contact name',
        },
        contact_email: {
          type: 'string',
          description: 'Primary contact email',
        },
        notes: {
          type: 'string',
          description: 'Notes to append (will be added with timestamp)',
        },
        domain: {
          type: 'string',
          description: 'Company domain for enrichment',
        },
      },
      required: ['org_id'],
    },
  },
  {
    name: 'enrich_company',
    description:
      'Research a company using Lusha to get firmographic data (revenue, employee count, industry, etc.). Can be used with a domain or company name.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Company domain to research (e.g., "thetradedesk.com")',
        },
        company_name: {
          type: 'string',
          description: 'Company name to search for (used if domain not provided)',
        },
        org_id: {
          type: 'string',
          description: 'If provided, save enrichment data to this organization',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_prospects',
    description:
      'List prospects with optional filtering. Use this to see recent prospects, find ones that need attention, or get an overview.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['prospect', 'contacted', 'responded', 'interested', 'negotiating', 'converted', 'declined', 'inactive'],
          description: 'Filter by status',
        },
        company_type: {
          type: 'string',
          enum: ['adtech', 'agency', 'brand', 'publisher', 'other'],
          description: 'Filter by company type',
        },
        limit: {
          type: 'number',
          description: 'Maximum number to return (default 10, max 50)',
        },
        sort: {
          type: 'string',
          enum: ['recent', 'name', 'activity'],
          description: 'Sort order: recent (newest first), name (alphabetical), activity (most recent activity)',
        },
      },
      required: [],
    },
  },
  {
    name: 'prospect_search_lusha',
    description:
      'Search Lusha\'s database for potential prospects matching criteria. Use this to find new companies to reach out to based on industry, size, or location.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to search for (e.g., ["programmatic", "DSP", "ad tech"])',
        },
        industries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Industry categories (e.g., ["Advertising", "Marketing", "Media"])',
        },
        min_employees: {
          type: 'number',
          description: 'Minimum employee count',
        },
        max_employees: {
          type: 'number',
          description: 'Maximum employee count',
        },
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Countries to include (e.g., ["United States", "United Kingdom"])',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 10)',
        },
      },
      required: [],
    },
  },
];

/**
 * Create admin tool handlers
 */
export function createAdminToolHandlers(
  memberContext: MemberContext | null
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // Check admin access before every tool
  const requireAdmin = (): string | null => {
    if (!isAdmin(memberContext)) {
      return '⚠️ This tool requires admin access. If you believe you should have admin access, please contact your organization administrator.';
    }
    return null;
  };

  // ============================================
  // ADD PROSPECT
  // ============================================
  handlers.set('add_prospect', async (input) => {
    const adminCheck = requireAdmin();
    if (adminCheck) return adminCheck;

    const name = input.name as string;
    const companyType = (input.company_type as string) || undefined;
    const domain = input.domain as string | undefined;
    const contactName = input.contact_name as string | undefined;
    const contactEmail = input.contact_email as string | undefined;
    const notes = input.notes as string | undefined;
    const source = (input.source as string) || 'addie_conversation';

    // Use the centralized prospect service (creates real WorkOS org)
    const result = await createProspect({
      name,
      domain,
      company_type: companyType,
      prospect_source: source,
      prospect_notes: notes,
      prospect_contact_name: contactName,
      prospect_contact_email: contactEmail,
    });

    if (!result.success) {
      if (result.alreadyExists && result.organization) {
        return `⚠️ A company named "${result.organization.name}" already exists (ID: ${result.organization.workos_organization_id}). Use find_prospect to see details or update_prospect to modify.`;
      }
      return `❌ Failed to create prospect: ${result.error}`;
    }

    const org = result.organization!;
    let response = `✅ Added **${org.name}** as a new prospect!\n\n`;
    if (org.company_type) response += `**Type:** ${org.company_type}\n`;
    if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
    if (contactName) response += `**Contact:** ${contactName}\n`;
    if (contactEmail) response += `**Email:** ${contactEmail}\n`;
    response += `**Status:** ${org.prospect_status}\n`;
    response += `**ID:** ${org.workos_organization_id}\n`;

    if (domain && isLushaConfigured()) {
      response += `\n_Enriching company data in background..._`;
    }

    return response;
  });

  // ============================================
  // FIND PROSPECT
  // ============================================
  handlers.set('find_prospect', async (input) => {
    const adminCheck = requireAdmin();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const query = input.query as string;
    const searchPattern = `%${query}%`;

    const result = await pool.query(
      `SELECT workos_organization_id, name, company_type, email_domain,
              prospect_status, prospect_source, prospect_contact_name,
              enrichment_at, enrichment_industry, enrichment_revenue, enrichment_employee_count,
              created_at, updated_at
       FROM organizations
       WHERE is_personal = false
         AND (LOWER(name) LIKE LOWER($1) OR LOWER(email_domain) LIKE LOWER($1))
       ORDER BY
         CASE WHEN LOWER(name) = LOWER($2) THEN 0
              WHEN LOWER(name) LIKE LOWER($3) THEN 1
              ELSE 2 END,
         updated_at DESC
       LIMIT 10`,
      [searchPattern, query, `${query}%`]
    );

    if (result.rows.length === 0) {
      return `No prospects found matching "${query}". Would you like me to add them as a new prospect?`;
    }

    let response = `## Found ${result.rows.length} match${result.rows.length === 1 ? '' : 'es'} for "${query}"\n\n`;

    for (const org of result.rows) {
      response += `### ${org.name}\n`;
      response += `**ID:** ${org.workos_organization_id}\n`;
      response += `**Type:** ${org.company_type || 'Not set'}\n`;
      if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
      response += `**Status:** ${org.prospect_status || 'unknown'}\n`;
      if (org.prospect_contact_name) response += `**Contact:** ${org.prospect_contact_name}\n`;
      if (org.enrichment_industry) response += `**Industry:** ${org.enrichment_industry}\n`;
      if (org.enrichment_employee_count) response += `**Employees:** ${org.enrichment_employee_count.toLocaleString()}\n`;
      if (org.enrichment_revenue) response += `**Revenue:** $${(org.enrichment_revenue / 1000000).toFixed(1)}M\n`;
      response += `**Created:** ${new Date(org.created_at).toLocaleDateString()}\n`;
      response += `\n`;
    }

    return response;
  });

  // ============================================
  // UPDATE PROSPECT
  // ============================================
  handlers.set('update_prospect', async (input) => {
    const adminCheck = requireAdmin();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const orgId = input.org_id as string;

    // Verify org exists
    const existing = await pool.query(
      `SELECT name, prospect_notes FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    );

    if (existing.rows.length === 0) {
      return `❌ Organization not found with ID: ${orgId}`;
    }

    const orgName = existing.rows[0].name;
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.company_type) {
      updates.push(`company_type = $${paramIndex++}`);
      values.push(input.company_type);
    }
    if (input.status) {
      updates.push(`prospect_status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.contact_name) {
      updates.push(`prospect_contact_name = $${paramIndex++}`);
      values.push(input.contact_name);
    }
    if (input.contact_email) {
      updates.push(`prospect_contact_email = $${paramIndex++}`);
      values.push(input.contact_email);
    }
    if (input.domain) {
      updates.push(`email_domain = $${paramIndex++}`);
      values.push(input.domain);
    }
    if (input.notes) {
      // Append to existing notes with timestamp
      const timestamp = new Date().toISOString().split('T')[0];
      const existingNotes = existing.rows[0].prospect_notes || '';
      const newNotes = existingNotes
        ? `${existingNotes}\n\n[${timestamp}] ${input.notes}`
        : `[${timestamp}] ${input.notes}`;
      updates.push(`prospect_notes = $${paramIndex++}`);
      values.push(newNotes);
    }

    if (updates.length === 0) {
      return `No updates provided. Specify at least one field to update (company_type, status, contact_name, contact_email, domain, notes).`;
    }

    updates.push(`updated_at = NOW()`);
    values.push(orgId);

    await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE workos_organization_id = $${paramIndex}`,
      values
    );

    let response = `✅ Updated **${orgName}**\n\n`;
    if (input.company_type) response += `• Company type → ${input.company_type}\n`;
    if (input.status) response += `• Status → ${input.status}\n`;
    if (input.contact_name) response += `• Contact → ${input.contact_name}\n`;
    if (input.contact_email) response += `• Email → ${input.contact_email}\n`;
    if (input.domain) response += `• Domain → ${input.domain}\n`;
    if (input.notes) response += `• Added note: "${input.notes}"\n`;

    // Trigger enrichment if domain was added
    if (input.domain && isLushaConfigured()) {
      response += `\n_Enriching with new domain..._`;
      enrichOrganization(orgId, input.domain as string).catch(err => {
        logger.warn({ err, orgId }, 'Background enrichment failed after update');
      });
    }

    return response;
  });

  // ============================================
  // ENRICH COMPANY
  // ============================================
  handlers.set('enrich_company', async (input) => {
    const adminCheck = requireAdmin();
    if (adminCheck) return adminCheck;

    if (!isLushaConfigured()) {
      return '❌ Enrichment is not configured (LUSHA_API_KEY not set).';
    }

    const domain = input.domain as string | undefined;
    const companyName = input.company_name as string | undefined;
    const orgId = input.org_id as string | undefined;

    if (!domain && !companyName) {
      return 'Please provide either a domain or company_name to research.';
    }

    let response = '';

    // If we have an org_id, enrich and save
    if (orgId && domain) {
      const result = await enrichOrganization(orgId, domain);
      if (result.success && result.data) {
        response = `## Enrichment Results for ${domain}\n\n`;
        response += `**Company:** ${result.data.companyName || 'Unknown'}\n`;
        if (result.data.industry) response += `**Industry:** ${result.data.industry}\n`;
        if (result.data.employeeCount) response += `**Employees:** ${result.data.employeeCount.toLocaleString()}\n`;
        if (result.data.revenueRange) response += `**Revenue:** ${result.data.revenueRange}\n`;
        if (result.data.suggestedCompanyType) response += `**Suggested Type:** ${result.data.suggestedCompanyType}\n`;
        response += `\n✅ Data saved to organization ${orgId}`;
      } else {
        response = `❌ Could not enrich ${domain}: ${result.error || 'Unknown error'}`;
      }
    } else if (domain) {
      // Just research without saving
      const result = await enrichDomain(domain);
      if (result.success && result.data) {
        response = `## Research Results for ${domain}\n\n`;
        response += `**Company:** ${result.data.companyName || 'Unknown'}\n`;
        if (result.data.industry) response += `**Industry:** ${result.data.industry}\n`;
        if (result.data.employeeCount) response += `**Employees:** ${result.data.employeeCount.toLocaleString()}\n`;
        if (result.data.revenueRange) response += `**Revenue:** ${result.data.revenueRange}\n`;
        if (result.data.suggestedCompanyType) response += `**Suggested Type:** ${result.data.suggestedCompanyType}\n`;
        response += `\n_To save this data, provide an org_id or add as new prospect._`;
      } else {
        response = `❌ Could not find information for ${domain}: ${result.error || 'Unknown error'}`;
      }
    } else if (companyName) {
      // Search by company name using Lusha
      const lusha = getLushaClient();
      if (!lusha) {
        return '❌ Lusha client not available.';
      }

      const searchResult = await lusha.searchCompanies(
        { keywords: [companyName] },
        1,
        5
      );

      if (searchResult.success && searchResult.companies && searchResult.companies.length > 0) {
        response = `## Search Results for "${companyName}"\n\n`;
        for (const company of searchResult.companies) {
          response += `### ${company.companyName}\n`;
          if (company.domain) response += `**Domain:** ${company.domain}\n`;
          if (company.mainIndustry) response += `**Industry:** ${company.mainIndustry}\n`;
          if (company.employeeCount) response += `**Employees:** ${company.employeeCount.toLocaleString()}\n`;
          if (company.country) response += `**Country:** ${company.country}\n`;
          response += `\n`;
        }
        response += `_Use enrich_company with a specific domain to get full details._`;
      } else {
        response = `No results found for "${companyName}" in Lusha's database.`;
      }
    }

    return response;
  });

  // ============================================
  // LIST PROSPECTS
  // ============================================
  handlers.set('list_prospects', async (input) => {
    const adminCheck = requireAdmin();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const status = input.status as string | undefined;
    const companyType = input.company_type as string | undefined;
    const limit = Math.min(Math.max((input.limit as number) || 10, 1), 50);
    const sort = (input.sort as string) || 'recent';

    const conditions: string[] = ['is_personal = false', "prospect_status IS NOT NULL"];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`prospect_status = $${paramIndex++}`);
      values.push(status);
    }
    if (companyType) {
      conditions.push(`company_type = $${paramIndex++}`);
      values.push(companyType);
    }

    let orderBy = 'created_at DESC';
    if (sort === 'name') orderBy = 'name ASC';
    if (sort === 'activity') orderBy = 'COALESCE(last_activity_at, created_at) DESC';

    values.push(limit);

    const result = await pool.query(
      `SELECT workos_organization_id, name, company_type, email_domain,
              prospect_status, prospect_contact_name, enrichment_industry, enrichment_employee_count,
              created_at, updated_at
       FROM organizations
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${paramIndex}`,
      values
    );

    if (result.rows.length === 0) {
      return `No prospects found${status ? ` with status "${status}"` : ''}${companyType ? ` of type "${companyType}"` : ''}.`;
    }

    let response = `## Prospects`;
    if (status) response += ` (${status})`;
    if (companyType) response += ` - ${companyType}`;
    response += `\n\n`;

    for (const org of result.rows) {
      const typeEmoji = {
        adtech: '🔧',
        agency: '🏢',
        brand: '🏷️',
        publisher: '📰',
        other: '📋',
      }[org.company_type as string] || '📋';

      response += `${typeEmoji} **${org.name}**`;
      if (org.prospect_status !== 'prospect') {
        response += ` (${org.prospect_status})`;
      }
      response += `\n`;
      if (org.prospect_contact_name) {
        response += `   Contact: ${org.prospect_contact_name}\n`;
      }
      if (org.enrichment_industry) {
        response += `   Industry: ${org.enrichment_industry}\n`;
      }
    }

    response += `\n_Showing ${result.rows.length} of ${limit} max. Use find_prospect for details._`;

    return response;
  });

  // ============================================
  // SEARCH LUSHA FOR PROSPECTS
  // ============================================
  handlers.set('prospect_search_lusha', async (input) => {
    const adminCheck = requireAdmin();
    if (adminCheck) return adminCheck;

    if (!isLushaConfigured()) {
      return '❌ Lusha is not configured (LUSHA_API_KEY not set).';
    }

    const lusha = getLushaClient();
    if (!lusha) {
      return '❌ Lusha client not available.';
    }

    const keywords = input.keywords as string[] | undefined;
    const limit = Math.min((input.limit as number) || 10, 25);

    const filters: Record<string, unknown> = {};
    if (keywords) filters.keywords = keywords;
    if (input.min_employees) filters.minEmployees = input.min_employees;
    if (input.max_employees) filters.maxEmployees = input.max_employees;
    if (input.countries) filters.countries = input.countries;

    const result = await lusha.searchCompanies(filters, 1, limit);

    if (!result.success || !result.companies || result.companies.length === 0) {
      return `No companies found matching your criteria. Try broadening your search.`;
    }

    let response = `## Lusha Search Results\n\n`;
    response += `Found ${result.total || result.companies.length} companies:\n\n`;

    for (const company of result.companies) {
      response += `### ${company.companyName}\n`;
      if (company.domain) response += `**Domain:** ${company.domain}\n`;
      if (company.mainIndustry) response += `**Industry:** ${company.mainIndustry}\n`;
      if (company.employeeCount) response += `**Employees:** ${company.employeeCount.toLocaleString()}\n`;
      if (company.country) response += `**Location:** ${company.country}\n`;

      const suggestedType = mapIndustryToCompanyType(company.mainIndustry || '', company.subIndustry || '');
      if (suggestedType) response += `**Suggested Type:** ${suggestedType}\n`;

      response += `\n`;
    }

    response += `\n_Use add_prospect to add any of these companies to your prospect list._`;

    return response;
  });

  return handlers;
}
