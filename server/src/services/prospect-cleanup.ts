/**
 * Intelligent prospect cleanup service using Claude
 *
 * Analyzes prospect data quality, enriches missing information,
 * identifies duplicates, and suggests cleanup actions.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getPool } from "../db/client.js";
import { createLogger } from "../logger.js";
import {
  getLushaClient,
  isLushaConfigured,
  mapIndustryToCompanyType,
} from "./lusha.js";
import { enrichOrganization } from "./enrichment.js";

const logger = createLogger("prospect-cleanup");

// Types for cleanup analysis
export interface ProspectIssue {
  type:
    | "missing_domain"
    | "missing_company_type"
    | "missing_contact"
    | "possible_duplicate"
    | "invalid_data"
    | "incomplete_info"
    | "stale_prospect";
  severity: "low" | "medium" | "high";
  description: string;
  suggestion?: string;
  auto_fixable: boolean;
}

export interface ProspectAnalysis {
  org_id: string;
  org_name: string;
  issues: ProspectIssue[];
  enrichment_available: boolean;
  suggested_actions: string[];
  can_auto_fix: boolean;
}

export interface CleanupReport {
  total_analyzed: number;
  issues_found: number;
  auto_fixable: number;
  analyses: ProspectAnalysis[];
  summary: string;
}

export interface CleanupAction {
  action:
    | "enrich"
    | "merge"
    | "update_type"
    | "add_domain"
    | "mark_inactive"
    | "delete";
  org_id: string;
  details: Record<string, unknown>;
}

export interface CleanupResult {
  success: boolean;
  action: CleanupAction;
  message: string;
  changes_made?: Record<string, unknown>;
}

// Tool definitions for Claude
const CLEANUP_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_prospect_details",
    description:
      "Get detailed information about a specific prospect organization including all fields and activity",
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: {
          type: "string",
          description: "The WorkOS organization ID",
        },
      },
      required: ["org_id"],
    },
  },
  {
    name: "search_prospects",
    description:
      "Search for prospects by name, domain, or other criteria to find potential duplicates or related orgs",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (name or domain substring)",
        },
        include_members: {
          type: "boolean",
          description: "Include member orgs in search (default false)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "enrich_prospect",
    description:
      "Enrich a prospect with company data from Lusha (revenue, employee count, industry, etc)",
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: {
          type: "string",
          description: "The WorkOS organization ID",
        },
        domain: {
          type: "string",
          description:
            "Domain to use for enrichment (if different from stored domain)",
        },
      },
      required: ["org_id"],
    },
  },
  {
    name: "update_prospect",
    description: "Update prospect fields like company_type, domain, or status",
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: {
          type: "string",
          description: "The WorkOS organization ID",
        },
        updates: {
          type: "object",
          description:
            "Fields to update (company_type, email_domain, prospect_status, prospect_notes)",
          properties: {
            company_type: {
              type: "string",
              enum: ["adtech", "agency", "brand", "publisher", "other"],
            },
            email_domain: { type: "string" },
            prospect_status: {
              type: "string",
              enum: [
                "prospect",
                "contacted",
                "responded",
                "interested",
                "negotiating",
                "converted",
                "declined",
                "inactive",
              ],
            },
            prospect_notes: { type: "string" },
          },
        },
      },
      required: ["org_id", "updates"],
    },
  },
  {
    name: "mark_duplicate",
    description:
      "Mark a prospect as a duplicate of another organization and optionally merge data",
    input_schema: {
      type: "object" as const,
      properties: {
        duplicate_org_id: {
          type: "string",
          description: "The org ID of the duplicate to be removed/merged",
        },
        primary_org_id: {
          type: "string",
          description:
            "The org ID of the primary organization to keep/merge into",
        },
        merge_notes: {
          type: "boolean",
          description: "Whether to merge notes from duplicate to primary",
        },
      },
      required: ["duplicate_org_id", "primary_org_id"],
    },
  },
  {
    name: "web_research",
    description:
      "Research a company online to find their domain, company type, or verify information",
    input_schema: {
      type: "object" as const,
      properties: {
        company_name: {
          type: "string",
          description: "Name of the company to research",
        },
        research_goal: {
          type: "string",
          description:
            "What information to find (e.g., 'find domain', 'verify industry', 'check if still in business')",
        },
      },
      required: ["company_name", "research_goal"],
    },
  },
];

// System prompt for prospect cleanup
const CLEANUP_SYSTEM_PROMPT = `You are an intelligent prospect data cleanup assistant for AgenticAdvertising.org, a membership organization for the ad tech industry.

Your job is to analyze prospect records and help clean up data quality issues. You have access to tools to:
- Get detailed prospect information
- Search for potential duplicates
- Enrich prospects with company data (Lusha API)
- Update prospect fields
- Mark duplicates for merging
- Research companies online

## Context about our organization types:
- **adtech**: Companies that provide advertising technology (DSPs, SSPs, ad servers, measurement, identity, etc.)
- **agency**: Media agencies, creative agencies, performance marketing agencies
- **brand**: Advertisers/marketers who buy advertising
- **publisher**: Media owners who sell advertising inventory
- **other**: Companies that don't fit the above categories

## Data Quality Goals:
1. Every prospect should have a domain (email_domain field)
2. Every prospect should have a company_type assigned
3. No duplicate organizations
4. Stale prospects (no activity in 6+ months) should be marked inactive or cleaned up
5. Contact information should be present when possible

## When analyzing prospects:
1. First understand what data is missing or problematic
2. Use enrichment when a domain exists but other data is missing
3. Use web research when domain is missing or data needs verification
4. Look for duplicates by searching similar names
5. Suggest specific, actionable fixes

Be concise and action-oriented. Focus on fixes that can be automated when possible.`;

/**
 * Prospect cleanup service using Claude for intelligent analysis
 */
export class ProspectCleanupService {
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model: string = "claude-sonnet-4-20250514") {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("ANTHROPIC_API_KEY is required for prospect cleanup");
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = model;
  }

  /**
   * Analyze prospects and identify issues
   */
  async analyzeProspects(options: {
    limit?: number;
    onlyProblematic?: boolean;
    orgIds?: string[];
  }): Promise<CleanupReport> {
    const pool = getPool();

    // Build query to get prospects
    let query = `
      SELECT
        o.workos_organization_id,
        o.name,
        o.company_type,
        o.email_domain,
        o.prospect_status,
        o.prospect_source,
        o.prospect_notes,
        o.prospect_contact_name,
        o.prospect_contact_email,
        o.subscription_status,
        o.enrichment_at,
        o.enrichment_industry,
        o.enrichment_revenue,
        o.enrichment_employee_count,
        o.created_at,
        o.updated_at,
        o.last_activity_at
      FROM organizations o
      WHERE o.is_personal = false
    `;

    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.orgIds && options.orgIds.length > 0) {
      query += ` AND o.workos_organization_id = ANY($${paramIndex})`;
      params.push(options.orgIds);
      paramIndex++;
    }

    if (options.onlyProblematic) {
      // Find orgs with missing data
      query += ` AND (
        o.email_domain IS NULL OR o.email_domain = ''
        OR o.company_type IS NULL
        OR (o.prospect_status = 'prospect' AND o.created_at < NOW() - INTERVAL '90 days')
      )`;
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${paramIndex}`;
    params.push(options.limit || 50);

    const result = await pool.query(query, params);
    const prospects = result.rows;

    logger.info(
      { count: prospects.length },
      "Analyzing prospects for cleanup"
    );

    const analyses: ProspectAnalysis[] = [];
    let issuesFound = 0;
    let autoFixable = 0;

    for (const prospect of prospects) {
      const issues: ProspectIssue[] = [];
      const suggestedActions: string[] = [];

      // Check for missing domain
      if (!prospect.email_domain) {
        issues.push({
          type: "missing_domain",
          severity: "high",
          description: "No email domain set - cannot auto-enrich",
          suggestion: "Research company to find domain, or ask user",
          auto_fixable: false,
        });
        suggestedActions.push(
          "Research domain online or extract from contact email"
        );
      }

      // Check for missing company type
      if (!prospect.company_type) {
        const canAutoFix = !!prospect.enrichment_industry || !!prospect.enrichment_at;
        issues.push({
          type: "missing_company_type",
          severity: "medium",
          description: "No company type assigned",
          suggestion: canAutoFix
            ? "Can infer from enrichment data"
            : "Needs manual classification or enrichment",
          auto_fixable: canAutoFix,
        });
        if (canAutoFix) {
          suggestedActions.push("Infer company type from industry data");
        } else if (prospect.email_domain) {
          suggestedActions.push("Enrich to get industry data");
        }
      }

      // Check for stale prospects
      const createdAt = new Date(prospect.created_at);
      const daysSinceCreated = Math.floor(
        (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
      );
      if (
        prospect.prospect_status === "prospect" &&
        daysSinceCreated > 90 &&
        !prospect.last_activity_at
      ) {
        issues.push({
          type: "stale_prospect",
          severity: "low",
          description: `Prospect for ${daysSinceCreated} days with no activity`,
          suggestion: "Consider marking inactive or reaching out",
          auto_fixable: false,
        });
        suggestedActions.push("Review if still relevant");
      }

      // Check for missing contact
      if (
        !prospect.prospect_contact_name &&
        !prospect.prospect_contact_email
      ) {
        issues.push({
          type: "missing_contact",
          severity: "low",
          description: "No contact information",
          suggestion: "Add primary contact for outreach",
          auto_fixable: false,
        });
      }

      // Check for unenriched prospects with domain
      if (
        prospect.email_domain &&
        !prospect.enrichment_at &&
        isLushaConfigured()
      ) {
        issues.push({
          type: "incomplete_info",
          severity: "medium",
          description: "Has domain but not enriched",
          suggestion: "Run enrichment to get company details",
          auto_fixable: true,
        });
        suggestedActions.push("Enrich with Lusha");
      }

      if (issues.length > 0) {
        issuesFound += issues.length;
        autoFixable += issues.filter((i) => i.auto_fixable).length;

        analyses.push({
          org_id: prospect.workos_organization_id,
          org_name: prospect.name,
          issues,
          enrichment_available:
            isLushaConfigured() && !!prospect.email_domain,
          suggested_actions: suggestedActions,
          can_auto_fix: issues.some((i) => i.auto_fixable),
        });
      }
    }

    return {
      total_analyzed: prospects.length,
      issues_found: issuesFound,
      auto_fixable: autoFixable,
      analyses,
      summary: `Analyzed ${prospects.length} prospects. Found ${issuesFound} issues (${autoFixable} auto-fixable) across ${analyses.length} organizations.`,
    };
  }

  /**
   * Auto-fix issues that can be resolved automatically
   */
  async autoFixIssues(
    analyses: ProspectAnalysis[]
  ): Promise<CleanupResult[]> {
    const results: CleanupResult[] = [];

    for (const analysis of analyses) {
      if (!analysis.can_auto_fix) continue;

      for (const issue of analysis.issues) {
        if (!issue.auto_fixable) continue;

        try {
          if (issue.type === "incomplete_info") {
            // Auto-enrich
            const pool = getPool();
            const orgResult = await pool.query(
              "SELECT email_domain FROM organizations WHERE workos_organization_id = $1",
              [analysis.org_id]
            );
            const domain = orgResult.rows[0]?.email_domain;

            if (domain) {
              const enrichResult = await enrichOrganization(
                analysis.org_id,
                domain
              );
              results.push({
                success: enrichResult.success,
                action: {
                  action: "enrich",
                  org_id: analysis.org_id,
                  details: { domain },
                },
                message: enrichResult.success
                  ? `Enriched ${analysis.org_name}`
                  : `Failed to enrich: ${enrichResult.error}`,
                changes_made: enrichResult.data,
              });
            }
          } else if (issue.type === "missing_company_type") {
            // Infer from enrichment industry
            const pool = getPool();
            const orgResult = await pool.query(
              "SELECT enrichment_industry, enrichment_sub_industry FROM organizations WHERE workos_organization_id = $1",
              [analysis.org_id]
            );
            const { enrichment_industry, enrichment_sub_industry } = orgResult.rows[0] || {};

            if (enrichment_industry) {
              const companyType = mapIndustryToCompanyType(
                enrichment_industry,
                enrichment_sub_industry
              );
              if (companyType) {
                await pool.query(
                  "UPDATE organizations SET company_type = $1, updated_at = NOW() WHERE workos_organization_id = $2",
                  [companyType, analysis.org_id]
                );
                results.push({
                  success: true,
                  action: {
                    action: "update_type",
                    org_id: analysis.org_id,
                    details: { company_type: companyType, from_industry: enrichment_industry },
                  },
                  message: `Set company type to ${companyType} based on industry "${enrichment_industry}"`,
                  changes_made: { company_type: companyType },
                });
              }
            }
          }
        } catch (error) {
          logger.error(
            { err: error, orgId: analysis.org_id, issueType: issue.type },
            "Auto-fix failed"
          );
          results.push({
            success: false,
            action: {
              action: "enrich",
              org_id: analysis.org_id,
              details: {},
            },
            message: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          });
        }
      }
    }

    return results;
  }

  /**
   * Use Claude to intelligently analyze and suggest fixes for a specific prospect
   */
  async analyzeWithClaude(orgId: string): Promise<{
    analysis: string;
    suggested_actions: CleanupAction[];
    tool_calls: Array<{ tool: string; input: unknown; result: string }>;
  }> {
    const toolCalls: Array<{
      tool: string;
      input: unknown;
      result: string;
    }> = [];

    // Tool handlers
    const handlers: Record<
      string,
      (input: Record<string, unknown>) => Promise<string>
    > = {
      get_prospect_details: async (input) => {
        const pool = getPool();
        const result = await pool.query(
          `SELECT * FROM organizations WHERE workos_organization_id = $1`,
          [input.org_id]
        );
        return JSON.stringify(result.rows[0] || { error: "Not found" }, null, 2);
      },

      search_prospects: async (input) => {
        const pool = getPool();
        const searchQuery = `%${input.query}%`;
        const result = await pool.query(
          `SELECT workos_organization_id, name, email_domain, company_type, prospect_status
           FROM organizations
           WHERE (name ILIKE $1 OR email_domain ILIKE $1)
           ${input.include_members ? "" : "AND subscription_status IS NULL"}
           LIMIT 10`,
          [searchQuery]
        );
        return JSON.stringify(result.rows, null, 2);
      },

      enrich_prospect: async (input) => {
        const pool = getPool();
        let domain = input.domain as string | undefined;

        if (!domain) {
          const orgResult = await pool.query(
            "SELECT email_domain FROM organizations WHERE workos_organization_id = $1",
            [input.org_id]
          );
          domain = orgResult.rows[0]?.email_domain;
        }

        if (!domain) {
          return JSON.stringify({
            error: "No domain available for enrichment",
          });
        }

        const result = await enrichOrganization(
          input.org_id as string,
          domain
        );
        return JSON.stringify(result, null, 2);
      },

      update_prospect: async (input) => {
        const updates = input.updates as Record<string, unknown>;
        const pool = getPool();

        const allowedFields = [
          "company_type",
          "email_domain",
          "prospect_status",
          "prospect_notes",
        ];
        const setClauses: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        for (const [key, value] of Object.entries(updates)) {
          if (allowedFields.includes(key)) {
            setClauses.push(`${key} = $${paramIndex}`);
            values.push(value);
            paramIndex++;
          }
        }

        if (setClauses.length === 0) {
          return JSON.stringify({ error: "No valid fields to update" });
        }

        values.push(input.org_id);
        await pool.query(
          `UPDATE organizations SET ${setClauses.join(", ")}, updated_at = NOW()
           WHERE workos_organization_id = $${paramIndex}`,
          values
        );

        return JSON.stringify({ success: true, updated: Object.keys(updates) });
      },

      mark_duplicate: async (input) => {
        const pool = getPool();

        // Get both orgs
        const [dupResult, primaryResult] = await Promise.all([
          pool.query(
            "SELECT * FROM organizations WHERE workos_organization_id = $1",
            [input.duplicate_org_id]
          ),
          pool.query(
            "SELECT * FROM organizations WHERE workos_organization_id = $1",
            [input.primary_org_id]
          ),
        ]);

        const dup = dupResult.rows[0];
        const primary = primaryResult.rows[0];

        if (!dup || !primary) {
          return JSON.stringify({ error: "One or both organizations not found" });
        }

        // Merge notes if requested
        if (input.merge_notes && dup.prospect_notes) {
          const mergedNotes = [
            primary.prospect_notes,
            `[Merged from ${dup.name}] ${dup.prospect_notes}`,
          ]
            .filter(Boolean)
            .join("\n\n");

          await pool.query(
            "UPDATE organizations SET prospect_notes = $1, updated_at = NOW() WHERE workos_organization_id = $2",
            [mergedNotes, input.primary_org_id]
          );
        }

        // Mark duplicate as inactive
        await pool.query(
          `UPDATE organizations
           SET prospect_status = 'inactive',
               prospect_notes = COALESCE(prospect_notes, '') || $1,
               updated_at = NOW()
           WHERE workos_organization_id = $2`,
          [
            `\n\n[DUPLICATE - merged into ${primary.name}]`,
            input.duplicate_org_id,
          ]
        );

        return JSON.stringify({
          success: true,
          message: `Marked ${dup.name} as duplicate of ${primary.name}`,
        });
      },

      web_research: async (input) => {
        // Use Claude's web search capability via a separate call
        try {
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 1024,
            messages: [
              {
                role: "user",
                content: `Research "${input.company_name}" to ${input.research_goal}. Provide factual information only - company website/domain, industry, and any relevant details.`,
              },
            ],
          });

          const text =
            response.content[0].type === "text"
              ? response.content[0].text
              : "No results";
          return text;
        } catch (error) {
          return `Research failed: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      },
    };

    // Start the analysis
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Analyze the prospect with org_id "${orgId}" and identify any data quality issues.

First, get the prospect details, then:
1. Check if any data is missing or incorrect
2. Look for potential duplicates by searching similar names
3. If enrichment is available and would help, use it
4. Suggest specific fixes

Be thorough but concise. Focus on actionable improvements.`,
      },
    ];

    let maxIterations = 10;
    let iteration = 0;
    const suggestedActions: CleanupAction[] = [];

    while (iteration < maxIterations) {
      iteration++;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: CLEANUP_SYSTEM_PROMPT,
        tools: CLEANUP_TOOLS,
        messages,
      });

      // Done - extract final analysis
      if (response.stop_reason === "end_turn") {
        const textBlock = response.content.find((c) => c.type === "text");
        const analysis =
          textBlock && textBlock.type === "text"
            ? textBlock.text
            : "Analysis complete";

        return {
          analysis,
          suggested_actions: suggestedActions,
          tool_calls: toolCalls,
        };
      }

      // Handle tool use
      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (c) => c.type === "tool_use"
        );

        const toolResults: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string;
        }> = [];

        for (const block of toolUseBlocks) {
          if (block.type !== "tool_use") continue;

          const handler = handlers[block.name];
          let result: string;

          if (handler) {
            try {
              result = await handler(block.input as Record<string, unknown>);
              toolCalls.push({
                tool: block.name,
                input: block.input,
                result,
              });

              // Track actions that modify data
              if (["update_prospect", "enrich_prospect", "mark_duplicate"].includes(block.name)) {
                suggestedActions.push({
                  action: block.name.replace("_prospect", "") as CleanupAction["action"],
                  org_id: (block.input as Record<string, unknown>).org_id as string || orgId,
                  details: block.input as Record<string, unknown>,
                });
              }
            } catch (error) {
              result = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
              toolCalls.push({
                tool: block.name,
                input: block.input,
                result,
              });
            }
          } else {
            result = `Unknown tool: ${block.name}`;
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }

        messages.push({
          role: "assistant",
          content: response.content as Anthropic.ContentBlock[],
        });
        messages.push({ role: "user", content: toolResults });
      }
    }

    return {
      analysis: "Analysis reached maximum iterations",
      suggested_actions: suggestedActions,
      tool_calls: toolCalls,
    };
  }

  /**
   * Batch analyze multiple prospects using Claude
   */
  async batchAnalyzeWithClaude(orgIds: string[]): Promise<{
    results: Array<{
      org_id: string;
      analysis: string;
      actions_taken: number;
    }>;
    summary: string;
  }> {
    const results: Array<{
      org_id: string;
      analysis: string;
      actions_taken: number;
    }> = [];

    for (const orgId of orgIds) {
      try {
        const result = await this.analyzeWithClaude(orgId);
        results.push({
          org_id: orgId,
          analysis: result.analysis,
          actions_taken: result.suggested_actions.length,
        });
      } catch (error) {
        logger.error({ err: error, orgId }, "Failed to analyze prospect");
        results.push({
          org_id: orgId,
          analysis: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          actions_taken: 0,
        });
      }

      // Small delay between analyses to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const totalActions = results.reduce((sum, r) => sum + r.actions_taken, 0);
    return {
      results,
      summary: `Analyzed ${results.length} prospects, took ${totalActions} actions total`,
    };
  }
}

// Singleton instance
let cleanupService: ProspectCleanupService | null = null;

export function getCleanupService(): ProspectCleanupService | null {
  if (!cleanupService && process.env.ANTHROPIC_API_KEY) {
    cleanupService = new ProspectCleanupService();
  }
  return cleanupService;
}

export function isCleanupConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
