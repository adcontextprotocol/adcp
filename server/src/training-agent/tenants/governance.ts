/**
 * /governance tenant — campaign-governance + property-lists +
 * collection-lists + content-standards specialisms.
 *
 * Bundles the governance/buyer-side specialisms in one tenant since
 * storyboards frequently span them (e.g., property-list policy cited in
 * a check_governance finding). Splitting further is a follow-up if any
 * specific surface needs distinct credentials or independent tenant
 * lifecycle.
 */

import { z } from 'zod';
import type { AdcpCredential, TenantConfig } from '@adcp/sdk/server';
import { TrainingGovernancePlatform } from '../v6-governance-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildGovernanceComplyConfig } from './comply.js';
import { listAccountsTool } from './account-tools.js';
import { customToolFor } from './custom-tool-helper.js';
import { handleReportPlanAdjustment } from '../governance-handlers.js';
import { trainingBuyerAgentRegistry } from '../buyer-agent-registry.js';
import type { TrainingContext } from '../types.js';

const TENANT_ID = 'governance';

const ADJUSTMENT_COMMON_SCHEMA = {
  account: z.object({}).passthrough().optional(),
  brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
  plan_id: z.string().min(1),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{16,255}$/),
  context: z.any().optional(),
  ext: z.any().optional(),
};

const REPORT_PLAN_ADJUSTMENT_SCHEMA = z.union([
  z.object({
    ...ADJUSTMENT_COMMON_SCHEMA,
    action: z.literal('report'),
    outcome_id: z.string().min(1),
    seller_reference: z.string().min(1).max(255),
    seller_adjustment_id: z.string().min(1).max(255),
    adjustment_type: z.enum(['decommitment', 'refund', 'credit', 'makegood']),
    amount: z.object({
      amount: z.number().positive().finite(),
      currency: z.string().regex(/^[A-Z]{3}$/),
    }).strict(),
    reason: z.string().min(1).max(1000),
    effective_at: z.string().datetime(),
    evidence: z.object({
      evidence_id: z.string().min(1).max(255),
      evidence_type: z.enum(['decommitment_agreement', 'refund_settlement', 'credit_note', 'makegood_agreement']),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      issued_at: z.string().datetime(),
    }).strict(),
  }),
  z.discriminatedUnion('decision', [
    z.object({
      ...ADJUSTMENT_COMMON_SCHEMA,
      action: z.literal('review'),
      adjustment_id: z.string().min(1),
      decision: z.literal('accept'),
      reason: z.string().min(1).max(1000).optional(),
    }),
    z.object({
      ...ADJUSTMENT_COMMON_SCHEMA,
      action: z.literal('review'),
      adjustment_id: z.string().min(1),
      decision: z.literal('dispute'),
      reason: z.string().min(1).max(1000),
    }),
  ]),
]);

async function resolveAuthenticatedAgentUrl(
  authInfo: { extra?: Record<string, unknown> } | undefined,
  params: Record<string, unknown>,
): Promise<string | undefined> {
  const credential = authInfo?.extra?.credential as AdcpCredential | undefined;
  const agent = await trainingBuyerAgentRegistry.resolve({
    credential,
    extra: authInfo?.extra,
    input: params,
  });
  return agent?.agent_url;
}

export function buildGovernanceTenantConfig(host: string, options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {}): {
  tenantId: string;
  config: TenantConfig;
} {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — governance',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingGovernancePlatform(options.storyboardCompat) as any,
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
          report_plan_adjustment: customToolFor(
            'report_plan_adjustment',
            'Report a seller adjustment or review it as the authenticated plan owner. Reporting alone never changes net cost or headroom.',
            REPORT_PLAN_ADJUSTMENT_SCHEMA,
            handleReportPlanAdjustment,
            {
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
              enforceIdempotency: true,
              resolveAuthenticatedAgentUrl,
            },
          ),
        },
        complyTest: buildGovernanceComplyConfig(),
      },
    },
  };
}
