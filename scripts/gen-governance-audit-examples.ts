/**
 * Drive the in-process training agent through three governance scenarios
 * (approved, conditions, denied) plus a mode comparison (enforce/advisory/audit)
 * and dump the audit-log responses for use as worked examples in
 * docs/governance/campaign/audit-trail.mdx.
 *
 * Run: npx tsx scripts/gen-governance-audit-examples.ts
 * Output: .context/audit-examples.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
} from '../server/src/training-agent/task-handlers.js';
import { clearSessions } from '../server/src/training-agent/state.js';
import { MUTATING_TOOLS } from '../server/src/training-agent/idempotency.js';
import type { TrainingContext } from '../server/src/training-agent/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const DEFAULT_CTX: TrainingContext = { mode: 'open' };

type ToolCall = { tool: string; args: Record<string, unknown>; result: Record<string, unknown>; isError?: boolean };

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key !== undefined) return args;
  return { ...args, idempotency_key: `gen-${randomUUID()}` };
}

// FIXME(framework-migration): reaches into the MCP Server's private
// `_requestHandlers` map. server/src/training-agent/FRAMEWORK_MIGRATION.md
// flags this exact pattern as in-flight migration to the McpServer wrapper
// (`server.server._requestHandlers`). When that lands, the four test files
// using the same pattern + this script should switch together; consider
// extracting a shared `simulateCallTool` helper at that point.
async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown, ctx: unknown) => Promise<{ structuredContent?: unknown; content?: Array<{ text?: string }>; isError?: boolean }>> })._requestHandlers;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withIdempotencyKey(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed = (response.structuredContent ?? (text ? JSON.parse(text) : {})) as Record<string, unknown>;
  const errorInBody = Array.isArray(parsed.errors) && parsed.errors.length > 0 ? parsed.errors[0] : undefined;
  const adcpError = parsed.adcp_error as Record<string, unknown> | undefined;
  const result = (adcpError ?? errorInBody ?? parsed) as Record<string, unknown>;
  return { result, isError: response.isError };
}

function tenant(domain: string) {
  return { account: { brand: { domain } } };
}

const PLAN_FLIGHT = { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' };

async function runApprovedScenario(): Promise<{ trail: ToolCall[]; audit: Record<string, unknown> }> {
  const server = createTrainingAgentServer(DEFAULT_CTX);
  const t = tenant('acme-coffee.example');
  const planId = 'plan_q1_2027_acme';
  const trail: ToolCall[] = [];

  trail.push({ tool: 'sync_plans', args: { plan_id: planId }, result: (await callTool(server, 'sync_plans', {
    ...t,
    plans: [{
      plan_id: planId,
      brand: { domain: 'acme-coffee.example', name: 'Acme Coffee' },
      objectives: 'Drive Q1 awareness for new cold-brew launch in US.',
      budget: { total: 500000, currency: 'USD', reallocation_threshold: 50000 },
      flight: PLAN_FLIGHT,
      channels: { allowed: ['olv', 'display'] },
      countries: ['US'],
      mode: 'enforce',
    }],
  })).result });

  trail.push({ tool: 'check_governance:intent', args: { phase: 'discovery' }, result: (await callTool(server, 'check_governance', {
    ...t,
    plan_id: planId,
    binding: 'proposed',
    caller: 'https://orchestrator.pinnacle-media.example',
    tool: 'get_products',
  })).result });

  trail.push({ tool: 'check_governance:execution', args: { tool: 'create_media_buy' }, result: (await callTool(server, 'check_governance', {
    ...t,
    plan_id: planId,
    binding: 'committed',
    caller: 'https://ads.seller-a.example',
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    payload: {
      total_budget: 150000,
      currency: 'USD',
      channels: ['olv'],
      flight: PLAN_FLIGHT,
    },
  })).result });

  // Pull governance_context from the execution check so the outcome correlates.
  const exec = trail[trail.length - 1].result as { governance_context?: string };
  trail.push({ tool: 'report_plan_outcome', args: {}, result: (await callTool(server, 'report_plan_outcome', {
    ...t,
    plan_id: planId,
    governance_context: exec.governance_context,
    outcome: 'completed',
    purchase_type: 'media_buy',
    seller_response: { committed_budget: 150000 },
  })).result });

  const auditCall = await callTool(server, 'get_plan_audit_logs', {
    ...t,
    plan_ids: [planId],
    include_entries: true,
  });

  return { trail, audit: auditCall.result };
}

async function runConditionsScenario(): Promise<{ trail: ToolCall[]; audit: Record<string, unknown> }> {
  const server = createTrainingAgentServer(DEFAULT_CTX);
  const t = tenant('nova-mortgage.example');
  const planId = 'plan_2027_nova_mortgage';
  const trail: ToolCall[] = [];

  // Annex III industry: mortgage/lending. Auto-flips human_review_required.
  trail.push({ tool: 'sync_plans', args: { plan_id: planId }, result: (await callTool(server, 'sync_plans', {
    ...t,
    plans: [{
      plan_id: planId,
      brand: { domain: 'nova-mortgage.example', name: 'Nova Mortgage', industry: 'mortgage' },
      objectives: 'Refinance awareness across approved markets.',
      budget: { total: 250000, currency: 'USD', reallocation_threshold: 25000 },
      flight: PLAN_FLIGHT,
      channels: { allowed: ['olv', 'display'] },
      countries: ['US'],
      policy_categories: ['fair_lending'],
      mode: 'enforce',
    }],
  })).result });

  trail.push({ tool: 'check_governance:intent', args: {}, result: (await callTool(server, 'check_governance', {
    ...t,
    plan_id: planId,
    binding: 'proposed',
    caller: 'https://orchestrator.pinnacle-media.example',
    tool: 'get_products',
  })).result });

  trail.push({ tool: 'check_governance:execution', args: { tool: 'create_media_buy' }, result: (await callTool(server, 'check_governance', {
    ...t,
    plan_id: planId,
    binding: 'committed',
    caller: 'https://ads.seller-a.example',
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    payload: {
      total_budget: 80000,
      currency: 'USD',
      channels: ['olv'],
      flight: PLAN_FLIGHT,
    },
  })).result });

  const exec = trail[trail.length - 1].result as { governance_context?: string };
  if (exec.governance_context) {
    trail.push({ tool: 'report_plan_outcome', args: {}, result: (await callTool(server, 'report_plan_outcome', {
      ...t,
      plan_id: planId,
      governance_context: exec.governance_context,
      outcome: 'completed',
      purchase_type: 'media_buy',
      committed_budget: 80000,
    })).result });
  }

  const auditCall = await callTool(server, 'get_plan_audit_logs', {
    ...t,
    plan_ids: [planId],
    include_entries: true,
  });

  return { trail, audit: auditCall.result };
}

async function runDeniedScenario(): Promise<{ trail: ToolCall[]; audit: Record<string, unknown> }> {
  const server = createTrainingAgentServer(DEFAULT_CTX);
  const t = tenant('apex-athletic.example');
  const planId = 'plan_2027_apex_athletic';
  const trail: ToolCall[] = [];

  trail.push({ tool: 'sync_plans', args: { plan_id: planId }, result: (await callTool(server, 'sync_plans', {
    ...t,
    plans: [{
      plan_id: planId,
      brand: { domain: 'apex-athletic.example', name: 'Apex Athletic' },
      objectives: 'Q2 brand campaign — only approved sellers.',
      budget: { total: 300000, currency: 'USD', reallocation_threshold: 30000 },
      flight: PLAN_FLIGHT,
      channels: { allowed: ['olv', 'display', 'ctv'] },
      countries: ['US'],
      approved_sellers: ['https://ads.seller-approved.example'],
      mode: 'enforce',
    }],
  })).result });

  // Approved seller — should pass.
  trail.push({ tool: 'check_governance:approved_seller', args: {}, result: (await callTool(server, 'check_governance', {
    ...t,
    plan_id: planId,
    binding: 'committed',
    caller: 'https://ads.seller-approved.example',
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    payload: { total_budget: 100000, currency: 'USD', channels: ['olv'], flight: PLAN_FLIGHT },
  })).result });

  // Unauthorized seller — should be denied.
  trail.push({ tool: 'check_governance:unauthorized_seller', args: {}, result: (await callTool(server, 'check_governance', {
    ...t,
    plan_id: planId,
    binding: 'committed',
    caller: 'https://ads.seller-rogue.example',
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    payload: { total_budget: 100000, currency: 'USD', channels: ['olv'], flight: PLAN_FLIGHT },
  })).result });

  const auditCall = await callTool(server, 'get_plan_audit_logs', {
    ...t,
    plan_ids: [planId],
    include_entries: true,
  });

  return { trail, audit: auditCall.result };
}

async function runModeComparison(): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const mode of ['enforce', 'advisory', 'audit'] as const) {
    invalidateCache();
    await clearSessions();
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const t = tenant(`apex-mode-${mode}.example`);
    const planId = `plan_mode_${mode}`;

    await callTool(server, 'sync_plans', {
      ...t,
      plans: [{
        plan_id: planId,
        brand: { domain: `apex-mode-${mode}.example`, name: 'Apex Athletic' },
        objectives: 'Demonstrate same denial under different modes.',
        budget: { total: 300000, currency: 'USD', reallocation_threshold: 30000 },
        flight: PLAN_FLIGHT,
        channels: { allowed: ['olv', 'display', 'ctv'] },
        countries: ['US'],
        approved_sellers: ['https://ads.seller-approved.example'],
        mode,
      }],
    });

    const { result } = await callTool(server, 'check_governance', {
      ...t,
      plan_id: planId,
      binding: 'committed',
      caller: 'https://ads.seller-rogue.example',
      tool: 'create_media_buy',
      purchase_type: 'media_buy',
      payload: { total_budget: 100000, currency: 'USD', channels: ['olv'], flight: PLAN_FLIGHT },
    });

    out[mode] = result;
  }
  return out;
}

async function main() {
  invalidateCache();
  await clearSessions();
  const approved = await runApprovedScenario();
  invalidateCache();
  await clearSessions();
  const conditions = await runConditionsScenario();
  invalidateCache();
  await clearSessions();
  const denied = await runDeniedScenario();
  const modeComparison = await runModeComparison();

  const out = { approved, conditions, denied, modeComparison };

  const outDir = join(REPO_ROOT, '.context');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'audit-examples.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);

  // Quick summary so the run is self-checking.
  const summarize = (label: string, scn: { trail: ToolCall[]; audit: Record<string, unknown> }) => {
    const checks = scn.trail.filter(c => c.tool.startsWith('check_governance')).map(c => ({
      tool: c.tool,
      status: (c.result as { status?: string }).status,
      findings: ((c.result as { findings?: unknown[] }).findings ?? []).length,
    }));
    const plans = (scn.audit as { plans?: Array<{ summary?: { statuses?: Record<string, number> } }> }).plans ?? [];
    const statuses = plans[0]?.summary?.statuses;
    console.log(`${label}: checks=${JSON.stringify(checks)} summary.statuses=${JSON.stringify(statuses)}`);
  };
  summarize('approved', approved);
  summarize('conditions', conditions);
  summarize('denied', denied);
  console.log('modeComparison:');
  for (const [mode, result] of Object.entries(modeComparison)) {
    const r = result as { status?: string; findings?: unknown[] };
    console.log(`  ${mode}: status=${r.status} findings=${(r.findings ?? []).length}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
