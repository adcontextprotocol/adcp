/**
 * Company enrichment and prospecting routes
 * Handles Lusha enrichment, company search, and prospecting
 */

import { Router } from "express";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin, requireManage } from "../../middleware/auth.js";
import {
  getLushaClient,
  isLushaConfigured,
  mapIndustryToCompanyType,
  formatRevenueRange,
} from "../../services/lusha.js";
import {
  enrichDomainsInBatch,
  autoEnrichOrganization,
  getEnrichmentStats,
  enrichMissingOrganizations,
} from "../../services/enrichment.js";
import { createProspect } from "../../services/prospect.js";

const logger = createLogger("admin-enrichment");

export function setupEnrichmentRoutes(apiRouter: Router): void {
  // GET /api/admin/enrichment/status - Check if enrichment is configured
  apiRouter.get(
    "/enrichment/status",
    requireAuth,
    requireManage,
    async (_req, res) => {
      res.json({
        configured: isLushaConfigured(),
        provider: isLushaConfigured() ? "lusha" : null,
      });
    }
  );

  // GET /api/admin/enrichment/stats - Get enrichment statistics
  apiRouter.get(
    "/enrichment/stats",
    requireAuth,
    requireManage,
    async (_req, res) => {
      try {
        const stats = await getEnrichmentStats();
        res.json(stats);
      } catch (error) {
        logger.error({ err: error }, "Error fetching enrichment stats");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch enrichment statistics",
        });
      }
    }
  );

  // POST /api/admin/enrichment/run - Run bulk enrichment
  apiRouter.post(
    "/enrichment/run",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        // Validate and sanitize inputs
        const limit = typeof req.body.limit === 'number'
          ? Math.min(Math.max(1, Math.floor(req.body.limit)), 100)
          : 50;
        const includeEmptyProspects = req.body.includeEmptyProspects !== false;

        // Cap limit to prevent abuse
        const cappedLimit = limit;

        logger.info(
          { limit: cappedLimit, includeEmptyProspects },
          "Starting bulk enrichment run"
        );

        const result = await enrichMissingOrganizations({
          limit: cappedLimit,
          includeEmptyProspects,
        });

        logger.info(
          {
            total: result.total,
            enriched: result.enriched,
            failed: result.failed,
            skipped: result.skipped,
          },
          "Bulk enrichment run complete"
        );

        res.json(result);
      } catch (error) {
        logger.error({ err: error }, "Error running bulk enrichment");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to run bulk enrichment",
        });
      }
    }
  );

  // POST /api/admin/enrichment/domain/:domain - Enrich a domain with company data
  apiRouter.post(
    "/enrichment/domain/:domain",
    requireAuth,
    requireManage,
    async (req, res) => {
      try {
        const { domain } = req.params;
        const { save_to_org_id } = req.body;

        const lusha = getLushaClient();
        if (!lusha) {
          return res.status(503).json({
            error: "Enrichment not configured",
            message: "LUSHA_API_KEY environment variable not set",
          });
        }

        const result = await lusha.enrichCompanyByDomain(domain);

        if (!result.success || !result.data) {
          return res.status(result.error === "Company not found" ? 404 : 500).json({
            error: result.error || "Enrichment failed",
          });
        }

        const enrichmentData = result.data;

        // Map to our company type
        const suggestedCompanyType = mapIndustryToCompanyType(
          enrichmentData.mainIndustry,
          enrichmentData.subIndustry
        );

        // Format revenue range if we have raw revenue
        const revenueRange =
          enrichmentData.revenueRange || formatRevenueRange(enrichmentData.revenue);

        // If save_to_org_id is provided, save the enrichment data to that org
        if (save_to_org_id) {
          const pool = getPool();
          await pool.query(
            `UPDATE organizations SET
              enrichment_data = $1,
              enrichment_source = 'lusha',
              enrichment_at = NOW(),
              enrichment_revenue = $2,
              enrichment_revenue_range = $3,
              enrichment_employee_count = $4,
              enrichment_employee_count_range = $5,
              enrichment_industry = $6,
              enrichment_sub_industry = $7,
              enrichment_founded_year = $8,
              enrichment_country = $9,
              enrichment_city = $10,
              enrichment_linkedin_url = $11,
              enrichment_description = $12,
              company_type = COALESCE(company_type, $13),
              updated_at = NOW()
            WHERE workos_organization_id = $14`,
            [
              JSON.stringify(enrichmentData),
              enrichmentData.revenue || null,
              revenueRange,
              enrichmentData.employeeCount || null,
              enrichmentData.employeeCountRange || null,
              enrichmentData.mainIndustry || null,
              enrichmentData.subIndustry || null,
              enrichmentData.foundedYear || null,
              enrichmentData.country || null,
              enrichmentData.city || null,
              enrichmentData.linkedinUrl || null,
              enrichmentData.description || null,
              suggestedCompanyType,
              save_to_org_id,
            ]
          );

          logger.info(
            { domain, orgId: save_to_org_id },
            "Saved enrichment data to organization"
          );
        }

        res.json({
          success: true,
          domain,
          enrichment: {
            companyName: enrichmentData.companyName,
            description: enrichmentData.description,
            employeeCount: enrichmentData.employeeCount,
            employeeCountRange: enrichmentData.employeeCountRange,
            revenue: enrichmentData.revenue,
            revenueRange: revenueRange,
            industry: enrichmentData.mainIndustry,
            subIndustry: enrichmentData.subIndustry,
            foundedYear: enrichmentData.foundedYear,
            country: enrichmentData.country,
            city: enrichmentData.city,
            linkedinUrl: enrichmentData.linkedinUrl,
          },
          suggested: {
            companyType: suggestedCompanyType,
            companyName: enrichmentData.companyName,
          },
          creditsUsed: result.creditsUsed,
          saved: !!save_to_org_id,
        });
      } catch (error) {
        logger.error({ err: error }, "Error enriching domain");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to enrich domain",
        });
      }
    }
  );

  // POST /api/admin/enrichment/bulk - Enrich multiple domains
  apiRouter.post(
    "/enrichment/bulk",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { domains } = req.body;

        if (!Array.isArray(domains) || domains.length === 0) {
          return res.status(400).json({
            error: "domains array required",
          });
        }

        if (domains.length > 25) {
          return res.status(400).json({
            error: "Maximum 25 domains per bulk request",
          });
        }

        const lusha = getLushaClient();
        if (!lusha) {
          return res.status(503).json({
            error: "Enrichment not configured",
            message: "LUSHA_API_KEY environment variable not set",
          });
        }

        const results = await lusha.enrichCompaniesInBulk(domains);

        const enrichments: Array<{
          domain: string;
          success: boolean;
          enrichment?: {
            companyName: string;
            employeeCount?: number;
            revenue?: number;
            industry?: string;
          };
          suggestedCompanyType?: string | null;
          error?: string;
        }> = [];

        for (const [domain, result] of results) {
          if (result.success && result.data) {
            enrichments.push({
              domain,
              success: true,
              enrichment: {
                companyName: result.data.companyName,
                employeeCount: result.data.employeeCount,
                revenue: result.data.revenue,
                industry: result.data.mainIndustry,
              },
              suggestedCompanyType: mapIndustryToCompanyType(
                result.data.mainIndustry,
                result.data.subIndustry
              ),
            });
          } else {
            enrichments.push({
              domain,
              success: false,
              error: result.error,
            });
          }
        }

        res.json({
          total: domains.length,
          successful: enrichments.filter((e) => e.success).length,
          failed: enrichments.filter((e) => !e.success).length,
          results: enrichments,
        });
      } catch (error) {
        logger.error({ err: error }, "Error bulk enriching domains");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to bulk enrich domains",
        });
      }
    }
  );

  // POST /api/admin/enrichment/auto-enrich-domains - Auto-enrich discovered domains
  apiRouter.post(
    "/enrichment/auto-enrich-domains",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { domains } = req.body;

        if (!Array.isArray(domains) || domains.length === 0) {
          return res.json({ results: [] });
        }

        // Limit to avoid abuse
        const domainsToEnrich = domains.slice(0, 20);

        const results = await enrichDomainsInBatch(domainsToEnrich);

        // Convert Map to array for JSON response
        const enrichmentResults = Array.from(results.entries()).map(
          ([domain, result]) => ({
            domain,
            success: result.success,
            cached: result.cached,
            data: result.data,
            error: result.error,
          })
        );

        res.json({
          results: enrichmentResults,
          total: enrichmentResults.length,
          successful: enrichmentResults.filter((r) => r.success).length,
        });
      } catch (error) {
        logger.error({ err: error }, "Error auto-enriching domains");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to auto-enrich domains",
        });
      }
    }
  );

  // POST /api/admin/enrichment/auto-enrich-org/:orgId - Auto-enrich a single organization
  apiRouter.post(
    "/enrichment/auto-enrich-org/:orgId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;

        const result = await autoEnrichOrganization(orgId);

        if (!result) {
          return res.status(404).json({
            error: "No domain found",
            message: "Organization does not have a domain to enrich",
          });
        }

        res.json({
          success: result.success,
          cached: result.cached,
          data: result.data,
          error: result.error,
        });
      } catch (error) {
        logger.error({ err: error }, "Error auto-enriching organization");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to auto-enrich organization",
        });
      }
    }
  );

  // =========================================================================
  // LUSHA COMPANY PROSPECTING / SEARCH
  // =========================================================================

  // GET /api/admin/prospecting/filters - Get available filter options
  apiRouter.get(
    "/prospecting/filters",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const lusha = getLushaClient();
        if (!lusha) {
          return res.status(503).json({
            error: "Lusha API not configured",
            message: "Set LUSHA_API_KEY environment variable",
          });
        }

        // Fetch all filter options in parallel
        const [industries, sizes, revenues] = await Promise.all([
          lusha.getIndustryFilters(),
          lusha.getCompanySizeFilters(),
          lusha.getRevenueFilters(),
        ]);

        res.json({
          industries,
          sizes,
          revenues,
          // Provide some preset industry groups for ad tech prospecting
          presets: {
            adtech: {
              label: "Ad Tech",
              description: "Advertising technology, programmatic, DSPs, SSPs",
              industryKeywords: ["advertising", "marketing", "programmatic"],
            },
            agencies: {
              label: "Agencies",
              description: "Media agencies, creative agencies, marketing services",
              industryKeywords: ["agency", "media buying", "creative"],
            },
            publishers: {
              label: "Publishers",
              description: "Media companies, content publishers, broadcasters",
              industryKeywords: ["media", "publishing", "broadcasting", "entertainment"],
            },
            brands: {
              label: "Brands",
              description: "Consumer brands, retail, CPG companies",
              industryKeywords: ["retail", "consumer", "food", "beverage", "automotive"],
            },
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching prospecting filters");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch prospecting filters",
        });
      }
    }
  );

  // POST /api/admin/prospecting/search - Search for companies by criteria
  apiRouter.post(
    "/prospecting/search",
    requireAuth,
    requireManage,
    async (req, res) => {
      try {
        const lusha = getLushaClient();
        if (!lusha) {
          return res.status(503).json({
            error: "Lusha API not configured",
            message: "Set LUSHA_API_KEY environment variable",
          });
        }

        const {
          industryIds,
          minEmployees,
          maxEmployees,
          companySizeIds,
          revenueIds,
          countries,
          states,
          cities,
          keywords,
          page = 1,
          pageSize = 25,
        } = req.body;

        const result = await lusha.searchCompanies(
          {
            industryIds,
            minEmployees,
            maxEmployees,
            companySizeIds,
            revenueIds,
            countries,
            states,
            cities,
            keywords,
          },
          page,
          pageSize
        );

        if (!result.success) {
          return res.status(400).json({
            error: result.error || "Search failed",
          });
        }

        // Cross-reference with existing organizations to mark duplicates
        const pool = getPool();
        const domains = result.companies
          .map((c) => c.domain)
          .filter((d) => d);

        let existingOrgs: Map<string, string> = new Map();
        if (domains.length > 0) {
          const existingResult = await pool.query(
            `SELECT email_domain, name FROM organizations WHERE email_domain = ANY($1)`,
            [domains]
          );
          existingOrgs = new Map(
            existingResult.rows.map((r) => [r.email_domain, r.name])
          );
        }

        // Enrich companies with our classification and existing org status
        const companies = result.companies.map((company) => {
          const existingOrgName = company.domain
            ? existingOrgs.get(company.domain)
            : null;
          const suggestedType = mapIndustryToCompanyType(
            company.mainIndustry,
            company.subIndustry
          );
          const suggestedRevenueRange =
            company.revenueRange || formatRevenueRange(company.revenue);

          return {
            ...company,
            suggestedCompanyType: suggestedType,
            suggestedRevenueRange,
            existingOrg: existingOrgName
              ? { name: existingOrgName, domain: company.domain }
              : null,
            isNewProspect: !existingOrgName,
          };
        });

        res.json({
          success: true,
          companies,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.page * result.pageSize < result.total,
        });
      } catch (error) {
        logger.error({ err: error }, "Error searching companies");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to search companies",
        });
      }
    }
  );

  // POST /api/admin/prospecting/import - Import a company as a prospect
  apiRouter.post(
    "/prospecting/import",
    requireAuth,
    requireManage,
    async (req, res) => {
      try {
        const { company, autoAssignOwner } = req.body;

        if (!company || !company.domain) {
          return res.status(400).json({
            error: "Missing required fields",
            message: "Company with domain is required",
          });
        }

        // Determine company type from industry
        const companyType = mapIndustryToCompanyType(
          company.mainIndustry,
          company.subIndustry
        );

        // Determine owner (current user if autoAssign)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentUserId = autoAssignOwner ? (req as any).user?.id : null;

        // Use centralized prospect service to create real WorkOS org
        const result = await createProspect({
          name: company.companyName || company.domain,
          domain: company.domain,
          company_type: companyType || undefined,
          prospect_source: "lusha_prospect",
          prospect_notes: "Imported from Lusha prospecting search",
          prospect_owner: currentUserId || undefined,
        });

        if (!result.success) {
          if (result.alreadyExists) {
            return res.status(409).json({
              error: "Organization already exists",
              existing: result.organization,
            });
          }
          return res.status(400).json({
            error: "Failed to create prospect",
            message: result.error,
          });
        }

        const orgId = result.organization!.workos_organization_id;

        // Update with enrichment data we already have from Lusha search
        // (avoids calling Lusha API again since we have the data)
        const pool = getPool();
        await pool.query(
          `UPDATE organizations SET
            enrichment_data = $1,
            enrichment_source = 'lusha',
            enrichment_at = NOW(),
            enrichment_revenue = $2,
            enrichment_revenue_range = $3,
            enrichment_employee_count = $4,
            enrichment_employee_count_range = $5,
            enrichment_industry = $6,
            enrichment_sub_industry = $7,
            enrichment_founded_year = $8,
            enrichment_country = $9,
            enrichment_city = $10,
            enrichment_linkedin_url = $11,
            enrichment_description = $12,
            updated_at = NOW()
          WHERE workos_organization_id = $13`,
          [
            JSON.stringify(company),
            company.revenue || null,
            company.revenueRange || formatRevenueRange(company.revenue) || null,
            company.employeeCount || null,
            company.employeeCountRange || null,
            company.mainIndustry || null,
            company.subIndustry || null,
            company.foundedYear || null,
            company.country || null,
            company.city || null,
            company.linkedinUrl || null,
            company.description || null,
            orgId,
          ]
        );

        logger.info(
          {
            domain: company.domain,
            name: company.companyName,
            orgId,
          },
          "Imported prospect from Lusha search"
        );

        res.json({
          success: true,
          organization: result.organization,
        });
      } catch (error) {
        logger.error({ err: error }, "Error importing prospect");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to import prospect",
        });
      }
    }
  );
}
