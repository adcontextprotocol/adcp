/**
 * Domain discovery and email contact routes
 * Handles Slack domain discovery, email contacts, and organization domains
 */

import { Router } from "express";
import { WorkOS, DomainDataState } from "@workos-inc/node";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { SlackDatabase } from "../../db/slack-db.js";
import { enrichOrganization } from "../../services/enrichment.js";

const slackDb = new SlackDatabase();
const logger = createLogger("admin-domains");

/**
 * SQL query to fetch combined activity history for a contact.
 * Combines email activities with event registrations via UNION ALL.
 * Parameter $1 is the contact UUID.
 */
const CONTACT_ACTIVITIES_QUERY = `
  SELECT * FROM (
    -- Email activities
    SELECT
      eca.id as activity_id,
      'email' as activity_type,
      eca.subject as title,
      eca.direction as description,
      eca.insights,
      eca.metadata,
      eca.email_date as activity_date,
      eca.created_at,
      eac.role,
      eac.is_primary
    FROM email_contact_activities eca
    INNER JOIN email_activity_contacts eac ON eac.activity_id = eca.id
    WHERE eac.contact_id = $1

    UNION ALL

    -- Event registrations
    SELECT
      er.id as activity_id,
      'event_registration' as activity_type,
      e.title as title,
      er.registration_status as description,
      NULL::TEXT as insights,
      jsonb_build_object(
        'event_id', er.event_id,
        'event_slug', e.slug,
        'ticket_type', er.ticket_type,
        'attended', er.attended,
        'registration_source', er.registration_source
      ) as metadata,
      er.registered_at as activity_date,
      er.created_at,
      'registrant' as role,
      true as is_primary
    FROM event_registrations er
    INNER JOIN events e ON e.id = er.event_id
    WHERE er.email_contact_id = $1
  ) combined
  ORDER BY activity_date DESC NULLS LAST
`;

interface DomainRoutesConfig {
  workos: WorkOS | null;
}

export function setupDomainRoutes(
  apiRouter: Router,
  config: DomainRoutesConfig
): void {
  const { workos } = config;

  // =========================================================================
  // SLACK DOMAIN DISCOVERY FOR PROSPECT IDENTIFICATION
  // =========================================================================

  // GET /api/admin/slack/domains - Get email domains from unmapped Slack users
  apiRouter.get(
    "/slack/domains",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { min_users, limit, include_free } = req.query;

        const domains = await slackDb.getUnmappedDomains({
          excludeFreeEmailProviders: include_free !== "true",
          minUsers: min_users ? parseInt(min_users as string, 10) : 1,
          limit: limit ? parseInt(limit as string, 10) : 100,
        });

        // Check which domains already have organizations
        const pool = getPool();
        const domainList = domains.map((d) => d.domain);

        // Query all matching domains at once
        const localDomainsResult = await pool.query(
          `SELECT od.domain, o.workos_organization_id, o.name
           FROM organization_domains od
           JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
           WHERE od.domain = ANY($1)`,
          [domainList]
        );

        // Build a map of domain -> org for fast lookup
        const domainToOrgMap = new Map<string, { id: string; name: string }>();
        for (const row of localDomainsResult.rows) {
          domainToOrgMap.set(row.domain, {
            id: row.workos_organization_id,
            name: row.name,
          });
        }

        // For domains not found locally, check WorkOS
        const missingDomains = domainList.filter((d) => !domainToOrgMap.has(d));

        if (missingDomains.length > 0 && workos) {
          await Promise.all(
            missingDomains.slice(0, 20).map(async (domainName) => {
              try {
                const orgs = await workos.organizations.listOrganizations({
                  limit: 1,
                  domains: [domainName],
                });
                if (orgs.data.length > 0) {
                  const orgResult = await pool.query(
                    `SELECT name FROM organizations WHERE workos_organization_id = $1`,
                    [orgs.data[0].id]
                  );
                  if (orgResult.rows.length > 0) {
                    domainToOrgMap.set(domainName, {
                      id: orgs.data[0].id,
                      name: orgResult.rows[0].name,
                    });
                  }
                }
              } catch {
                // Ignore WorkOS lookup errors
              }
            })
          );
        }

        // Enrich domains with org info
        const enrichedDomains = domains.map((domain) => {
          const existingOrg = domainToOrgMap.get(domain.domain) || null;
          return {
            ...domain,
            existing_org: existingOrg,
            is_new_prospect: !existingOrg,
          };
        });

        res.json({
          domains: enrichedDomains,
          total: enrichedDomains.length,
          new_prospect_count: enrichedDomains.filter((d) => d.is_new_prospect)
            .length,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching Slack domains");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch Slack domains",
        });
      }
    }
  );

  // POST /api/admin/slack/domains/:domain/create-prospect - Create a prospect from a Slack domain
  apiRouter.post(
    "/slack/domains/:domain/create-prospect",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { domain } = req.params;
        const { name, prospect_notes } = req.body;

        if (!workos) {
          return res.status(500).json({ error: "WorkOS not configured" });
        }

        // Get the users from this domain for context
        const domainData = await slackDb.getUnmappedDomains({
          excludeFreeEmailProviders: false,
          minUsers: 1,
        });
        const domainInfo = domainData.find(
          (d) => d.domain.toLowerCase() === domain.toLowerCase()
        );

        if (!domainInfo) {
          return res.status(404).json({
            error: "Domain not found in unmapped Slack users",
          });
        }

        // Generate a name if not provided
        const orgName =
          name ||
          domain
            .split(".")
            .slice(0, -1)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ");

        // Create organization in WorkOS with the domain
        const workosOrg = await workos.organizations.createOrganization({
          name: orgName,
          domainData: [{ domain: domain, state: DomainDataState.Verified }],
        });

        logger.info(
          { orgId: workosOrg.id, name: orgName, domain },
          "Created WorkOS organization from Slack domain"
        );

        // Create local record
        const pool = getPool();
        const slackUserNames = domainInfo.users
          .map((u) => u.slack_real_name || u.slack_display_name)
          .filter(Boolean)
          .slice(0, 5)
          .join(", ");

        const notes =
          prospect_notes ||
          `Discovered via Slack. ${domainInfo.user_count} user(s) in Slack workspace: ${slackUserNames}`;

        const result = await pool.query(
          `INSERT INTO organizations (
            workos_organization_id,
            name,
            prospect_status,
            prospect_source,
            prospect_notes
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *`,
          [workosOrg.id, orgName, "prospect", "slack_discovery", notes]
        );

        // Auto-enrich the new organization in the background
        enrichOrganization(workosOrg.id, domain).catch((err) => {
          logger.warn({ err, domain, orgId: workosOrg.id }, "Background enrichment failed");
        });

        res.status(201).json({
          ...result.rows[0],
          domain,
          slack_users: domainInfo.users,
          workos_org: {
            id: workosOrg.id,
            domains: workosOrg.domains,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error creating prospect from Slack domain");

        if (error instanceof Error && error.message.includes("domain")) {
          return res.status(400).json({
            error: "Domain error",
            message: error.message,
          });
        }

        res.status(500).json({
          error: "Internal server error",
          message: "Unable to create prospect",
        });
      }
    }
  );

  // =========================================================================
  // EMAIL CONTACT DOMAIN DISCOVERY
  // =========================================================================

  // GET /api/admin/email/domains - Get email domains from unmapped email contacts
  apiRouter.get(
    "/email/domains",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { min_users, limit, include_free } = req.query;
        const excludeFree = include_free !== "true";
        const minUsers = min_users ? parseInt(min_users as string, 10) : 1;
        const resultLimit = limit ? parseInt(limit as string, 10) : 100;

        // Common free email providers to exclude
        const freeEmailDomains = [
          'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
          'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
          'mac.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com',
          'yandex.com', 'gmx.com', 'gmx.net', 'fastmail.com', 'tutanota.com',
        ];

        const pool = getPool();

        // Build the exclude clause for free email providers
        let domainExcludeClause = '';
        const params: (string | number)[] = [];
        if (excludeFree) {
          const placeholders = freeEmailDomains.map((_, i) => `$${i + 1}`).join(', ');
          domainExcludeClause = `AND LOWER(domain) NOT IN (${placeholders})`;
          params.push(...freeEmailDomains);
        }

        // Query unmapped email contacts grouped by domain
        const domainQuery = `
          SELECT
            LOWER(domain) as domain,
            COUNT(*) as user_count,
            json_agg(json_build_object(
              'email', email,
              'display_name', display_name,
              'email_count', email_count,
              'last_seen_at', last_seen_at
            ) ORDER BY email_count DESC) as users
          FROM email_contacts
          WHERE mapping_status = 'unmapped'
            AND domain IS NOT NULL
            ${domainExcludeClause}
          GROUP BY LOWER(domain)
          HAVING COUNT(*) >= $${params.length + 1}
          ORDER BY COUNT(*) DESC
          LIMIT $${params.length + 2}
        `;

        params.push(minUsers, resultLimit);
        const domainsResult = await pool.query(domainQuery, params);

        // Check which domains already have organizations
        const enrichedDomains = await Promise.all(
          domainsResult.rows.map(async (domain) => {
            let existingOrg = null;
            try {
              if (workos) {
                const orgs = await workos.organizations.listOrganizations({
                  limit: 1,
                  domains: [domain.domain],
                });
                if (orgs.data.length > 0) {
                  const orgResult = await pool.query(
                    `SELECT name, workos_organization_id FROM organizations WHERE workos_organization_id = $1`,
                    [orgs.data[0].id]
                  );
                  if (orgResult.rows.length > 0) {
                    existingOrg = {
                      id: orgs.data[0].id,
                      name: orgResult.rows[0].name,
                    };
                  }
                }
              }
            } catch {
              // Ignore lookup errors
            }

            return {
              domain: domain.domain,
              user_count: parseInt(domain.user_count, 10),
              users: domain.users,
              existing_org: existingOrg,
              is_new_prospect: !existingOrg,
              source: 'email' as const,
            };
          })
        );

        res.json(enrichedDomains);
      } catch (error) {
        logger.error({ err: error }, "Error fetching email domains");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch email domains",
        });
      }
    }
  );

  // POST /api/admin/email/domains/:domain/create-prospect - Create a prospect from an email domain
  apiRouter.post(
    "/email/domains/:domain/create-prospect",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { domain } = req.params;
        const { name, prospect_notes } = req.body;

        if (!workos) {
          return res.status(500).json({ error: "WorkOS not configured" });
        }

        const pool = getPool();

        // Get the contacts from this domain for context
        const contactsResult = await pool.query(
          `SELECT email, display_name, email_count, last_seen_at
           FROM email_contacts
           WHERE mapping_status = 'unmapped'
             AND LOWER(domain) = LOWER($1)
           ORDER BY email_count DESC
           LIMIT 10`,
          [domain]
        );

        if (contactsResult.rows.length === 0) {
          return res.status(404).json({
            error: "Domain not found in unmapped email contacts",
          });
        }

        // Generate a name if not provided
        const orgName =
          name ||
          domain
            .split(".")
            .slice(0, -1)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ");

        // Create organization in WorkOS with the domain
        const workosOrg = await workos.organizations.createOrganization({
          name: orgName,
          domainData: [{ domain: domain, state: DomainDataState.Verified }],
        });

        logger.info(
          { orgId: workosOrg.id, name: orgName, domain },
          "Created WorkOS organization from email domain"
        );

        // Create local record
        const contactNames = contactsResult.rows
          .map((c) => c.display_name || c.email.split("@")[0])
          .filter(Boolean)
          .slice(0, 5)
          .join(", ");

        const notes =
          prospect_notes ||
          `Discovered via email contacts. ${contactsResult.rows.length} contact(s): ${contactNames}`;

        const result = await pool.query(
          `INSERT INTO organizations (
            workos_organization_id,
            name,
            prospect_status,
            prospect_source,
            prospect_notes
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *`,
          [workosOrg.id, orgName, "prospect", "email_discovery", notes]
        );

        // Auto-enrich the new organization in the background
        enrichOrganization(workosOrg.id, domain).catch((err) => {
          logger.warn({ err, domain, orgId: workosOrg.id }, "Background enrichment failed");
        });

        res.status(201).json({
          ...result.rows[0],
          domain,
          email_contacts: contactsResult.rows,
          workos_org: {
            id: workosOrg.id,
            domains: workosOrg.domains,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error creating prospect from email domain");

        if (error instanceof Error && error.message.includes("domain")) {
          return res.status(400).json({
            error: "Domain error",
            message: error.message,
          });
        }

        res.status(500).json({
          error: "Internal server error",
          message: "Unable to create prospect",
        });
      }
    }
  );

  // =========================================================================
  // EMAIL CONTACT MANAGEMENT
  // =========================================================================

  // GET /api/admin/email/contacts - Search and list email contacts
  apiRouter.get(
    "/email/contacts",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const { search, domain, status, limit: limitParam, offset: offsetParam } = req.query;
        const resultLimit = limitParam ? parseInt(limitParam as string, 10) : 50;
        const resultOffset = offsetParam ? parseInt(offsetParam as string, 10) : 0;

        const params: (string | number)[] = [];
        const conditions: string[] = [];

        if (search && typeof search === 'string') {
          params.push(`%${search.toLowerCase()}%`);
          conditions.push(`(LOWER(email) LIKE $${params.length} OR LOWER(display_name) LIKE $${params.length})`);
        }

        if (domain && typeof domain === 'string') {
          params.push(domain.toLowerCase());
          conditions.push(`LOWER(domain) = $${params.length}`);
        }

        if (status && typeof status === 'string') {
          params.push(status);
          conditions.push(`mapping_status = $${params.length}`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Get total count
        const countResult = await pool.query(
          `SELECT COUNT(*) FROM email_contacts ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].count, 10);

        // Get contacts with their activity count
        params.push(resultLimit, resultOffset);
        const contactsResult = await pool.query(
          `SELECT
            ec.id,
            ec.email,
            ec.display_name,
            ec.domain,
            ec.workos_user_id,
            ec.organization_id,
            ec.mapping_status,
            ec.mapping_source,
            ec.first_seen_at,
            ec.last_seen_at,
            ec.email_count,
            ec.created_at,
            ec.updated_at,
            o.name as organization_name,
            (SELECT COUNT(*) FROM email_activity_contacts eac WHERE eac.contact_id = ec.id) as activity_count
          FROM email_contacts ec
          LEFT JOIN organizations o ON ec.organization_id = o.workos_organization_id
          ${whereClause}
          ORDER BY ec.last_seen_at DESC NULLS LAST
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );

        res.json({
          contacts: contactsResult.rows,
          total,
          limit: resultLimit,
          offset: resultOffset,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching email contacts");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch email contacts",
        });
      }
    }
  );

  // GET /api/admin/email/contacts/:id - Get contact details with activity history
  apiRouter.get(
    "/email/contacts/:id",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const { id } = req.params;

        // Get contact details
        const contactResult = await pool.query(
          `SELECT
            ec.id,
            ec.email,
            ec.display_name,
            ec.domain,
            ec.workos_user_id,
            ec.organization_id,
            ec.mapping_status,
            ec.mapping_source,
            ec.first_seen_at,
            ec.last_seen_at,
            ec.email_count,
            ec.mapped_at,
            ec.mapped_by_user_id,
            ec.created_at,
            ec.updated_at,
            o.name as organization_name,
            o.company_type as organization_type,
            o.prospect_status as organization_prospect_status
          FROM email_contacts ec
          LEFT JOIN organizations o ON ec.organization_id = o.workos_organization_id
          WHERE ec.id = $1`,
          [id]
        );

        if (contactResult.rows.length === 0) {
          return res.status(404).json({ error: "Contact not found" });
        }

        const contact = contactResult.rows[0];

        // Get activity history for this contact (emails + event registrations)
        const activitiesResult = await pool.query(CONTACT_ACTIVITIES_QUERY, [id]);

        res.json({
          ...contact,
          activities: activitiesResult.rows,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching email contact details");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch email contact details",
        });
      }
    }
  );

  // GET /api/admin/email/contacts/by-email/:email - Lookup contact by email address
  apiRouter.get(
    "/email/contacts/by-email/:email",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const { email } = req.params;

        // Get contact by email
        const contactResult = await pool.query(
          `SELECT
            ec.id,
            ec.email,
            ec.display_name,
            ec.domain,
            ec.workos_user_id,
            ec.organization_id,
            ec.mapping_status,
            ec.mapping_source,
            ec.first_seen_at,
            ec.last_seen_at,
            ec.email_count,
            ec.mapped_at,
            ec.mapped_by_user_id,
            ec.created_at,
            ec.updated_at,
            o.name as organization_name,
            o.company_type as organization_type,
            o.prospect_status as organization_prospect_status
          FROM email_contacts ec
          LEFT JOIN organizations o ON ec.organization_id = o.workos_organization_id
          WHERE LOWER(ec.email) = LOWER($1)`,
          [email]
        );

        if (contactResult.rows.length === 0) {
          return res.status(404).json({ error: "Contact not found" });
        }

        const contact = contactResult.rows[0];

        // Get activity history for this contact (emails + event registrations)
        const activitiesResult = await pool.query(CONTACT_ACTIVITIES_QUERY, [contact.id]);

        res.json({
          ...contact,
          activities: activitiesResult.rows,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching email contact by email");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch email contact",
        });
      }
    }
  );

  // =========================================================================
  // SLACK ACTIVITY INSIGHTS FOR ENGAGEMENT TRACKING
  // =========================================================================

  // GET /api/admin/slack/activity/top-users - Get most active Slack users
  apiRouter.get(
    "/slack/activity/top-users",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { days, limit, mapped_only } = req.query;

        const users = await slackDb.getMostActiveUsers({
          days: days ? parseInt(days as string, 10) : 30,
          limit: limit ? parseInt(limit as string, 10) : 50,
          mappedOnly: mapped_only === "true",
        });

        res.json({
          users,
          total: users.length,
          period_days: days ? parseInt(days as string, 10) : 30,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching top Slack users");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch top Slack users",
        });
      }
    }
  );

  // GET /api/admin/slack/activity/user/:slackUserId - Get activity summary for a Slack user
  apiRouter.get(
    "/slack/activity/user/:slackUserId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { slackUserId } = req.params;
        const { days } = req.query;

        const [summary, mapping] = await Promise.all([
          slackDb.getActivitySummary(slackUserId, {
            days: days ? parseInt(days as string, 10) : 30,
          }),
          slackDb.getBySlackUserId(slackUserId),
        ]);

        if (!mapping) {
          return res.status(404).json({ error: "Slack user not found" });
        }

        res.json({
          user: {
            slack_user_id: mapping.slack_user_id,
            slack_email: mapping.slack_email,
            slack_real_name: mapping.slack_real_name,
            slack_display_name: mapping.slack_display_name,
            workos_user_id: mapping.workos_user_id,
            mapping_status: mapping.mapping_status,
          },
          activity: summary,
          period_days: days ? parseInt(days as string, 10) : 30,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching Slack user activity");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch Slack user activity",
        });
      }
    }
  );

  // GET /api/admin/organizations/:orgId/slack-activity - Get Slack activity for an org
  apiRouter.get(
    "/organizations/:orgId/slack-activity",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { days } = req.query;

        const summary = await slackDb.getOrgActivitySummary(orgId, {
          days: days ? parseInt(days as string, 10) : 30,
        });

        res.json({
          organization_id: orgId,
          activity: summary,
          period_days: days ? parseInt(days as string, 10) : 30,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching org Slack activity");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch organization Slack activity",
        });
      }
    }
  );

  // =========================================================================
  // ORGANIZATION DOMAINS API
  // =========================================================================

  // GET /api/admin/organizations/:orgId/domains - List domains for an organization
  apiRouter.get(
    "/organizations/:orgId/domains",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const pool = getPool();

        // Get org info
        const orgResult = await pool.query(
          `SELECT name, email_domain FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        // Get all domains from our local table
        const domainsResult = await pool.query(
          `SELECT domain, is_primary, verified, source, created_at
           FROM organization_domains
           WHERE workos_organization_id = $1
           ORDER BY is_primary DESC, created_at ASC`,
          [orgId]
        );

        // Also get domains from WorkOS for comparison
        let workOSDomains: Array<{ domain: string; state: string }> = [];
        if (workos) {
          try {
            const workOSOrg = await workos.organizations.getOrganization(orgId);
            workOSDomains = workOSOrg.domains.map((d) => ({
              domain: d.domain,
              state: d.state,
            }));
          } catch {
            // Org might not exist in WorkOS
          }
        }

        res.json({
          organization_id: orgId,
          organization_name: orgResult.rows[0].name,
          primary_domain: orgResult.rows[0].email_domain,
          domains: domainsResult.rows,
          workos_domains: workOSDomains,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching organization domains");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch organization domains",
        });
      }
    }
  );

  // POST /api/admin/organizations/:orgId/domains - Add a domain to an organization
  // Writes to WorkOS first, then local DB is updated via webhook (or immediately for consistency)
  apiRouter.post(
    "/organizations/:orgId/domains",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { domain, is_primary } = req.body;

        if (!domain) {
          return res.status(400).json({ error: "domain is required" });
        }

        if (!workos) {
          return res.status(500).json({ error: "WorkOS not configured" });
        }

        const normalizedDomain = domain.toLowerCase().trim();

        // Validate domain format
        const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/;
        if (!domainRegex.test(normalizedDomain)) {
          return res.status(400).json({
            error: "Invalid domain format",
            message: `"${normalizedDomain}" is not a valid domain. Expected format: "example.com" or "sub.example.com"`,
          });
        }

        const pool = getPool();

        // Verify org exists
        const orgResult = await pool.query(
          `SELECT name FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        // Check if domain is already claimed by another org locally
        const existingResult = await pool.query(
          `SELECT od.workos_organization_id, o.name as org_name
           FROM organization_domains od
           JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
           WHERE od.domain = $1`,
          [normalizedDomain]
        );

        if (existingResult.rows.length > 0) {
          const existingOrg = existingResult.rows[0];
          if (existingOrg.workos_organization_id !== orgId) {
            return res.status(409).json({
              error: "Domain already claimed",
              message: `Domain ${normalizedDomain} is already associated with ${existingOrg.org_name}`,
              existing_organization_id: existingOrg.workos_organization_id,
            });
          }
          // Domain already belongs to this org
          return res.json({
            success: true,
            message: "Domain already associated with this organization",
            domain: normalizedDomain,
          });
        }

        // Add to WorkOS first - this is the source of truth
        try {
          const workosOrg = await workos.organizations.getOrganization(orgId);
          const existingDomains = workosOrg.domains.map(d => ({
            domain: d.domain,
            state: d.state === 'verified' ? DomainDataState.Verified : DomainDataState.Pending
          }));

          await workos.organizations.updateOrganization({
            organization: orgId,
            domainData: [...existingDomains, { domain: normalizedDomain, state: DomainDataState.Verified }],
          });
        } catch (workosErr) {
          logger.error({ err: workosErr, domain: normalizedDomain, orgId }, "Failed to add domain to WorkOS");
          return res.status(500).json({
            error: "WorkOS error",
            message: `Failed to add domain to WorkOS: ${workosErr instanceof Error ? workosErr.message : 'Unknown error'}`,
          });
        }

        // If setting as primary, clear existing primary first
        if (is_primary) {
          await pool.query(
            `UPDATE organization_domains SET is_primary = false, updated_at = NOW()
             WHERE workos_organization_id = $1 AND is_primary = true`,
            [orgId]
          );
        }

        // Insert/update local DB immediately (webhook will also do this, but for immediate consistency)
        await pool.query(
          `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source)
           VALUES ($1, $2, $3, true, 'workos')
           ON CONFLICT (domain) DO UPDATE SET
             workos_organization_id = EXCLUDED.workos_organization_id,
             is_primary = EXCLUDED.is_primary,
             verified = true,
             source = 'workos',
             updated_at = NOW()`,
          [orgId, normalizedDomain, is_primary || false]
        );

        // If primary, also update the email_domain column
        if (is_primary) {
          await pool.query(
            `UPDATE organizations SET email_domain = $1, updated_at = NOW()
             WHERE workos_organization_id = $2`,
            [normalizedDomain, orgId]
          );
        }

        logger.info({ orgId, domain: normalizedDomain, isPrimary: is_primary }, "Added domain to organization via WorkOS");

        res.json({
          success: true,
          domain: normalizedDomain,
          is_primary: is_primary || false,
          synced_to_workos: true,
        });
      } catch (error) {
        logger.error({ err: error }, "Error adding organization domain");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to add organization domain",
        });
      }
    }
  );

  // DELETE /api/admin/organizations/:orgId/domains/:domain - Remove a domain from an organization
  // Removes from WorkOS first, then local DB is updated via webhook (or immediately for consistency)
  apiRouter.delete(
    "/organizations/:orgId/domains/:domain",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId, domain } = req.params;
        const normalizedDomain = domain.toLowerCase().trim();
        const pool = getPool();

        if (!workos) {
          return res.status(500).json({ error: "WorkOS not configured" });
        }

        // Get domain info before deletion
        const domainResult = await pool.query(
          `SELECT is_primary, source FROM organization_domains
           WHERE workos_organization_id = $1 AND domain = $2`,
          [orgId, normalizedDomain]
        );

        if (domainResult.rows.length === 0) {
          return res.status(404).json({ error: "Domain not found for this organization" });
        }

        const wasPrimary = domainResult.rows[0].is_primary;

        // Remove from WorkOS first - this is the source of truth
        try {
          const workosOrg = await workos.organizations.getOrganization(orgId);
          const remainingDomains = workosOrg.domains
            .filter(d => d.domain.toLowerCase() !== normalizedDomain)
            .map(d => ({
              domain: d.domain,
              state: d.state === 'verified' ? DomainDataState.Verified : DomainDataState.Pending
            }));

          await workos.organizations.updateOrganization({
            organization: orgId,
            domainData: remainingDomains,
          });
        } catch (workosErr) {
          logger.error({ err: workosErr, domain: normalizedDomain, orgId }, "Failed to remove domain from WorkOS");
          return res.status(500).json({
            error: "WorkOS error",
            message: `Failed to remove domain from WorkOS: ${workosErr instanceof Error ? workosErr.message : 'Unknown error'}`,
          });
        }

        // Delete from local DB
        await pool.query(
          `DELETE FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
          [orgId, normalizedDomain]
        );

        // If we deleted the primary domain, pick a new one
        let newPrimary: string | null = null;
        if (wasPrimary) {
          const remaining = await pool.query(
            `SELECT domain FROM organization_domains
             WHERE workos_organization_id = $1
             ORDER BY verified DESC, created_at ASC
             LIMIT 1`,
            [orgId]
          );

          newPrimary = remaining.rows.length > 0 ? remaining.rows[0].domain : null;

          if (newPrimary) {
            await pool.query(
              `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
               WHERE workos_organization_id = $1 AND domain = $2`,
              [orgId, newPrimary]
            );
          }

          await pool.query(
            `UPDATE organizations SET email_domain = $1, updated_at = NOW()
             WHERE workos_organization_id = $2`,
            [newPrimary, orgId]
          );
        }

        logger.info({ orgId, domain: normalizedDomain, wasPrimary, newPrimary }, "Removed domain from organization via WorkOS");

        res.json({
          success: true,
          domain: normalizedDomain,
          was_primary: wasPrimary,
          new_primary: newPrimary,
        });
      } catch (error) {
        logger.error({ err: error }, "Error removing organization domain");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to remove organization domain",
        });
      }
    }
  );

  // PUT /api/admin/organizations/:orgId/domains/:domain/primary - Set a domain as primary
  apiRouter.put(
    "/organizations/:orgId/domains/:domain/primary",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId, domain } = req.params;
        const normalizedDomain = domain.toLowerCase().trim();
        const pool = getPool();

        // Verify domain belongs to this org
        const domainResult = await pool.query(
          `SELECT domain FROM organization_domains
           WHERE workos_organization_id = $1 AND domain = $2`,
          [orgId, normalizedDomain]
        );

        if (domainResult.rows.length === 0) {
          return res.status(404).json({ error: "Domain not found for this organization" });
        }

        // Clear existing primary
        await pool.query(
          `UPDATE organization_domains SET is_primary = false, updated_at = NOW()
           WHERE workos_organization_id = $1 AND is_primary = true`,
          [orgId]
        );

        // Set new primary
        await pool.query(
          `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
           WHERE workos_organization_id = $1 AND domain = $2`,
          [orgId, normalizedDomain]
        );

        // Update organizations.email_domain
        await pool.query(
          `UPDATE organizations SET email_domain = $1, updated_at = NOW()
           WHERE workos_organization_id = $2`,
          [normalizedDomain, orgId]
        );

        logger.info({ orgId, domain: normalizedDomain }, "Set primary domain for organization");

        res.json({
          success: true,
          primary_domain: normalizedDomain,
        });
      } catch (error) {
        logger.error({ err: error }, "Error setting primary domain");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to set primary domain",
        });
      }
    }
  );

  // =========================================================================
  // DOMAIN HEALTH API
  // =========================================================================

  // Common free email providers to exclude from corporate domain checks
  const freeEmailDomains = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
    'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
    'mac.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com',
  ];

  // GET /api/admin/domain-health - Get domain health summary and issues
  apiRouter.get(
    "/domain-health",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

        // Build parameterized query for free email exclusion
        const freeEmailPlaceholders = freeEmailDomains.map((_, i) => `$${i + 1}`).join(', ');

        // 1. Orphan corporate domains - domains not linked to any org, but users may already be members
        const orphanResult = await pool.query(`
          WITH user_domains AS (
            SELECT
              LOWER(SPLIT_PART(om.email, '@', 2)) as domain,
              COUNT(DISTINCT om.workos_user_id) as user_count,
              array_agg(DISTINCT jsonb_build_object(
                'email', om.email,
                'first_name', om.first_name,
                'last_name', om.last_name,
                'user_id', om.workos_user_id
              )) as users
            FROM organization_memberships om
            WHERE om.email IS NOT NULL
              AND LOWER(SPLIT_PART(om.email, '@', 2)) NOT IN (${freeEmailPlaceholders})
            GROUP BY LOWER(SPLIT_PART(om.email, '@', 2))
          ),
          claimed_domains AS (
            SELECT LOWER(domain) as domain FROM organization_domains
            UNION
            SELECT LOWER(email_domain) FROM organizations WHERE email_domain IS NOT NULL
          ),
          domain_orgs AS (
            -- Find which orgs users with each domain actually belong to
            SELECT
              LOWER(SPLIT_PART(om.email, '@', 2)) as domain,
              array_agg(DISTINCT jsonb_build_object(
                'org_id', o.workos_organization_id,
                'name', o.name,
                'is_personal', o.is_personal,
                'user_count', (
                  SELECT COUNT(DISTINCT om2.workos_user_id)
                  FROM organization_memberships om2
                  WHERE om2.workos_organization_id = o.workos_organization_id
                    AND LOWER(SPLIT_PART(om2.email, '@', 2)) = LOWER(SPLIT_PART(om.email, '@', 2))
                )
              )) as existing_orgs
            FROM organization_memberships om
            JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
            WHERE om.email IS NOT NULL
              AND LOWER(SPLIT_PART(om.email, '@', 2)) NOT IN (${freeEmailPlaceholders})
            GROUP BY LOWER(SPLIT_PART(om.email, '@', 2))
          )
          SELECT ud.domain, ud.user_count, ud.users, dorgs.existing_orgs
          FROM user_domains ud
          LEFT JOIN claimed_domains cd ON cd.domain = ud.domain
          LEFT JOIN domain_orgs dorgs ON dorgs.domain = ud.domain
          WHERE cd.domain IS NULL
          ORDER BY ud.user_count DESC
          LIMIT $${freeEmailDomains.length + 1}
        `, [...freeEmailDomains, limit]);

        // 2. Misaligned users (corporate emails in personal workspaces)
        const misalignedResult = await pool.query(`
          SELECT
            om.email,
            om.first_name,
            om.last_name,
            om.workos_user_id,
            LOWER(SPLIT_PART(om.email, '@', 2)) as email_domain,
            o.name as workspace_name,
            om.workos_organization_id
          FROM organization_memberships om
          JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
          WHERE o.is_personal = true
            AND om.email IS NOT NULL
            AND LOWER(SPLIT_PART(om.email, '@', 2)) NOT IN (${freeEmailPlaceholders})
          ORDER BY LOWER(SPLIT_PART(om.email, '@', 2)), om.email
          LIMIT $${freeEmailDomains.length + 1}
        `, [...freeEmailDomains, limit]);

        // 3. Orgs without verified domains
        const unverifiedResult = await pool.query(`
          SELECT
            o.workos_organization_id,
            o.name,
            o.email_domain,
            o.subscription_status,
            COUNT(DISTINCT om.workos_user_id) as user_count,
            array_agg(DISTINCT LOWER(SPLIT_PART(om.email, '@', 2))) FILTER (WHERE om.email IS NOT NULL) as user_domains
          FROM organizations o
          JOIN organization_memberships om ON om.workos_organization_id = o.workos_organization_id
          LEFT JOIN organization_domains od ON od.workos_organization_id = o.workos_organization_id AND od.verified = true
          WHERE o.is_personal = false
            AND od.id IS NULL
          GROUP BY o.workos_organization_id, o.name, o.email_domain, o.subscription_status
          HAVING COUNT(DISTINCT om.workos_user_id) > 0
          ORDER BY COUNT(DISTINCT om.workos_user_id) DESC
          LIMIT $1
        `, [limit]);

        // 4. Domain conflicts
        const conflictResult = await pool.query(`
          SELECT
            email_domain,
            COUNT(*) as org_count,
            json_agg(json_build_object(
              'id', workos_organization_id,
              'name', name,
              'subscription_status', subscription_status
            ) ORDER BY name) as organizations
          FROM organizations
          WHERE is_personal = false AND email_domain IS NOT NULL
          GROUP BY email_domain
          HAVING COUNT(*) > 1
          ORDER BY COUNT(*) DESC
          LIMIT $1
        `, [limit]);

        // 5. Summary stats
        const statsResult = await pool.query(`
          SELECT
            (SELECT COUNT(*) FROM organizations WHERE is_personal = false) as total_orgs,
            (SELECT COUNT(DISTINCT domain) FROM organization_domains WHERE verified = true) as verified_domains,
            (SELECT COUNT(DISTINCT domain) FROM organization_domains WHERE verified = false OR verified IS NULL) as unverified_domains,
            (SELECT COUNT(DISTINCT LOWER(SPLIT_PART(email, '@', 2))) FROM organization_memberships WHERE email IS NOT NULL) as total_email_domains
        `);

        // Group misaligned users by domain
        const misalignedByDomain: Record<string, typeof misalignedResult.rows> = {};
        for (const row of misalignedResult.rows) {
          if (!misalignedByDomain[row.email_domain]) {
            misalignedByDomain[row.email_domain] = [];
          }
          misalignedByDomain[row.email_domain].push(row);
        }

        res.json({
          summary: {
            total_organizations: parseInt(statsResult.rows[0].total_orgs, 10),
            verified_domains: parseInt(statsResult.rows[0].verified_domains, 10),
            unverified_domains: parseInt(statsResult.rows[0].unverified_domains, 10),
            total_email_domains: parseInt(statsResult.rows[0].total_email_domains, 10),
            issues: {
              orphan_domains: orphanResult.rows.length,
              misaligned_users: misalignedResult.rows.length,
              unverified_orgs: unverifiedResult.rows.length,
              domain_conflicts: conflictResult.rows.length,
            },
          },
          orphan_domains: orphanResult.rows.map(row => ({
            domain: row.domain,
            user_count: parseInt(row.user_count, 10),
            users: row.users.slice(0, 10), // Limit to 10 users per domain
            existing_orgs: row.existing_orgs || [], // Orgs users already belong to
          })),
          misaligned_users: Object.entries(misalignedByDomain).map(([domain, users]) => ({
            domain,
            user_count: users.length,
            users: users.map(u => ({
              email: u.email,
              first_name: u.first_name,
              last_name: u.last_name,
              user_id: u.workos_user_id,
              workspace_name: u.workspace_name,
              org_id: u.workos_organization_id,
            })),
          })),
          unverified_orgs: unverifiedResult.rows.map(row => ({
            org_id: row.workos_organization_id,
            name: row.name,
            email_domain: row.email_domain,
            subscription_status: row.subscription_status,
            user_count: parseInt(row.user_count, 10),
            user_domains: row.user_domains?.filter(Boolean) || [],
          })),
          domain_conflicts: conflictResult.rows.map(row => ({
            domain: row.email_domain,
            org_count: parseInt(row.org_count, 10),
            organizations: row.organizations,
          })),
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching domain health");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch domain health data",
        });
      }
    }
  );
}
