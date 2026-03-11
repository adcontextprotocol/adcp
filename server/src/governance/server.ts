/**
 * Community governance agent MCP server.
 *
 * Implements the four campaign governance tools:
 * - sync_plans: Push campaign plans, resolve applicable policies
 * - check_governance: Validate actions against plans and policies
 * - report_plan_outcome: Report action outcomes, update budget state
 * - get_plan_audit_logs: Retrieve governance state and audit trail
 *
 * Uses Claude for policy evaluation, deterministic code for budget/geo/channel checks.
 * Hosted alongside Addie at the same server, accessible via /governance/mcp.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger.js';
import { handleSyncPlans } from './tools/sync-plans.js';
import { handleCheckGovernance } from './tools/check-governance.js';
import { handleReportPlanOutcome } from './tools/report-plan-outcome.js';
import { handleGetPlanAuditLogs } from './tools/get-plan-audit-logs.js';

const logger = createLogger('governance-server');

const TOOLS = [
  {
    name: 'sync_plans',
    description: 'Push campaign plans to the governance agent. Plans define authorized parameters for budget, channels, flight dates, and markets. The governance agent resolves applicable policies from the brand compliance configuration and returns the active policy set.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plans: {
          type: 'array',
          description: 'Campaign plans to sync.',
          items: {
            type: 'object',
            properties: {
              plan_id: { type: 'string', description: 'Plan identifier.' },
              brand: {
                type: 'object',
                properties: {
                  domain: { type: 'string', description: 'Brand house domain.' },
                  brand_id: { type: 'string', description: 'Brand ID within a house of brands.' },
                },
                required: ['domain'],
              },
              objectives: { type: 'string', description: 'Campaign objectives in natural language.' },
              budget: {
                type: 'object',
                properties: {
                  total: { type: 'number' },
                  currency: { type: 'string' },
                  authority_level: { type: 'string', enum: ['agent_full', 'agent_limited', 'human_required'] },
                  per_seller_max_pct: { type: 'number' },
                  reallocation_threshold: { type: 'number' },
                },
                required: ['total', 'currency', 'authority_level'],
              },
              channels: {
                type: 'object',
                properties: {
                  required: { type: 'array', items: { type: 'string' } },
                  allowed: { type: 'array', items: { type: 'string' } },
                  mix_targets: { type: 'object' },
                },
              },
              flight: {
                type: 'object',
                properties: {
                  start: { type: 'string' },
                  end: { type: 'string' },
                },
                required: ['start', 'end'],
              },
              countries: { type: 'array', items: { type: 'string' } },
              regions: { type: 'array', items: { type: 'string' } },
              approved_sellers: { type: 'array', items: { type: 'string' } },
              ext: { type: 'object' },
            },
            required: ['plan_id', 'brand', 'objectives', 'budget', 'flight'],
          },
        },
      },
      required: ['plans'],
    },
  },
  {
    name: 'check_governance',
    description: 'Validate an action against a campaign plan. Orchestrators call with binding: "proposed" before sending to sellers. Sellers call with binding: "committed" before executing. Returns approval status, findings, and conditions.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        buyer_campaign_ref: { type: 'string' },
        binding: { type: 'string', enum: ['proposed', 'committed'] },
        caller: { type: 'string' },
        tool: { type: 'string', description: 'AdCP tool name (required for proposed checks).' },
        payload: { type: 'object', description: 'Tool arguments (required for proposed checks).' },
        media_buy_id: { type: 'string', description: 'Media buy ID (required for committed checks).' },
        buyer_ref: { type: 'string' },
        phase: { type: 'string', enum: ['purchase', 'modification', 'delivery'] },
        planned_delivery: { type: 'object', description: 'Seller planned delivery (required for committed checks).' },
        delivery_metrics: { type: 'object', description: 'Delivery metrics (required for delivery phase).' },
        modification_summary: { type: 'string' },
      },
      required: ['plan_id', 'buyer_campaign_ref', 'binding', 'caller'],
    },
  },
  {
    name: 'report_plan_outcome',
    description: 'Report the outcome of an action to update plan state. Links actions to governance checks and tracks budget commitment from confirmed outcomes.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        check_id: { type: 'string', description: 'Check ID from check_governance (required for completed/failed).' },
        buyer_campaign_ref: { type: 'string' },
        outcome: { type: 'string', enum: ['completed', 'failed', 'delivery'] },
        seller_response: { type: 'object' },
        delivery: { type: 'object' },
        error: { type: 'object' },
      },
      required: ['plan_id', 'buyer_campaign_ref', 'outcome'],
    },
  },
  {
    name: 'get_plan_audit_logs',
    description: 'Retrieve governance state and audit trail for a campaign plan. Returns budget status, campaign summaries, check/outcome statistics, and optionally the full audit trail.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        buyer_campaign_ref: { type: 'string', description: 'Filter to specific campaign.' },
        include_entries: { type: 'boolean', description: 'Include full audit trail entries.' },
      },
      required: ['plan_id'],
    },
  },
];

/**
 * Create the community governance agent MCP server.
 */
export function createGovernanceServer(accountId: string): Server {
  const server = new Server(
    {
      name: 'community-governance-agent',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.debug({ tool: name, accountId }, 'Governance: Tool call');

    try {
      let result: unknown;

      switch (name) {
        case 'sync_plans':
          result = await handleSyncPlans(accountId, args as any);
          break;
        case 'check_governance':
          result = await handleCheckGovernance(accountId, args as any);
          break;
        case 'report_plan_outcome':
          result = await handleReportPlanOutcome(accountId, args as any);
          break;
        case 'get_plan_audit_logs':
          result = await handleGetPlanAuditLogs(accountId, args as any);
          break;
        default:
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      logger.error({ error, tool: name }, 'Governance: Tool execution error');
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }) }],
        isError: true,
      };
    }
  });

  return server;
}
