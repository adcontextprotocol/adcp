/**
 * v6 governance-tier platform for the `/governance` tenant.
 *
 * Bundles four specialisms that share governance/buyer-side
 * responsibilities — campaign governance (spend-authority +
 * delivery-monitor), property-lists, collection-lists, content-standards.
 * Single tenant rather than four because the governance storyboards
 * frequently span these surfaces (e.g., property-lists policy cited in
 * a check_governance finding).
 *
 * Spike-grade port: bodies shim through to v5 handlers via
 * `translateV5Result` — same approach as `/signals` and `/sales`.
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type CampaignGovernancePlatform,
  type PropertyListsPlatform,
  type CollectionListsPlatform,
  type ContentStandardsPlatform,
  type AccountStore,
} from '@adcp/sdk/server';
import {
  handleSyncPlans,
  handleCheckGovernance,
  handleReportPlanOutcome,
  handleGetPlanAuditLogs,
} from './governance-handlers.js';
import {
  handleCreatePropertyList,
  handleListPropertyLists,
  handleGetPropertyList,
  handleUpdatePropertyList,
  handleDeletePropertyList,
} from './property-handlers.js';
import {
  handleCreateCollectionList,
  handleGetCollectionList,
  handleUpdateCollectionList,
  handleListCollectionLists,
  handleDeleteCollectionList,
} from './inventory-governance-handlers.js';
import {
  handleCreateContentStandards,
  handleListContentStandards,
  handleGetContentStandards,
  handleUpdateContentStandards,
  handleCalibrateContent,
  handleValidateContentDelivery,
} from './content-standards-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingGovernanceMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingGovernanceConfig {
  strict: boolean;
}

function buildTrainingCtx(account: { authInfo?: { principal?: string } } | undefined): TrainingContext {
  return {
    mode: 'open',
    principal: account?.authInfo?.principal ?? 'anonymous',
  };
}

function translateV5Result<T extends object>(result: unknown): T {
  const errs = (result as {
    errors?: Array<{
      code: string;
      message: string;
      field?: string;
      details?: unknown;
      recovery?: string;
    }>;
  } | undefined)?.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const first = errs[0]!;
    const recovery = (first.recovery === 'transient' || first.recovery === 'correctable' || first.recovery === 'terminal')
      ? first.recovery
      : 'correctable';
    throw new AdcpError(first.code, {
      recovery,
      message: first.message,
      ...(first.field !== undefined && { field: first.field }),
      ...(first.details !== undefined && { details: first.details as Record<string, unknown> }),
    });
  }
  return result as T;
}

const trainingGovernanceAccounts: AccountStore<TrainingGovernanceMeta> = {
  resolution: 'explicit',
  resolve: async (ref, _ctx) => {
    if (ref == null) {
      return {
        id: 'public_sandbox',
        name: 'Public Sandbox',
        status: 'active',
        ctx_metadata: {},
        sandbox: true,
        authInfo: { kind: 'public' },
      };
    }
    const brandDomain =
      'brand' in ref && ref.brand && typeof ref.brand === 'object' && 'domain' in ref.brand
        ? (ref.brand.domain as string | undefined)
        : undefined;
    const accountId =
      'account_id' in ref && typeof ref.account_id === 'string' ? ref.account_id : undefined;
    const id = accountId ?? `synthetic_${brandDomain ?? 'anon'}`;
    return {
      id,
      name: brandDomain ?? id,
      status: 'active',
      ...(brandDomain != null && { brand: { domain: brandDomain } }),
      ...('operator' in ref && typeof ref.operator === 'string' && { operator: ref.operator }),
      ctx_metadata: { brand_domain: brandDomain },
      sandbox: true,
      authInfo: { kind: 'api_key' },
    };
  },
  upsert: syncAccountsUpsert,
};

export class TrainingGovernancePlatform
  implements DecisioningPlatform<TrainingGovernanceConfig, TrainingGovernanceMeta>
{
  capabilities = {
    specialisms: [
      'governance-spend-authority',
      'governance-delivery-monitor',
      'property-lists',
      'collection-lists',
      'content-standards',
    ] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm', 'cpa'] as const,
    supportedBillings: ['agent', 'operator'] as const,
    compliance_testing: {},
    config: { strict: false },
  };

  statusMappers = {};
  accounts: AccountStore<TrainingGovernanceMeta> = trainingGovernanceAccounts;
  agentRegistry = trainingBuyerAgentRegistry;

  campaignGovernance: CampaignGovernancePlatform<TrainingGovernanceMeta> = {
    syncPlans: async (req, ctx) => {
      const result = await handleSyncPlans(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    checkGovernance: async (req, ctx) => {
      const result = await handleCheckGovernance(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    reportPlanOutcome: async (req, ctx) => {
      const result = await handleReportPlanOutcome(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    getPlanAuditLogs: async (req, ctx) => {
      const result = await handleGetPlanAuditLogs(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
  };

  propertyLists: PropertyListsPlatform<TrainingGovernanceMeta> = {
    createPropertyList: async (req, ctx) => {
      const result = await handleCreatePropertyList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    updatePropertyList: async (req, ctx) => {
      const result = await handleUpdatePropertyList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    getPropertyList: async (req, ctx) => {
      const result = await handleGetPropertyList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    listPropertyLists: async (req, ctx) => {
      const result = await handleListPropertyLists(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    deletePropertyList: async (req, ctx) => {
      const result = await handleDeletePropertyList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
  };

  collectionLists: CollectionListsPlatform<TrainingGovernanceMeta> = {
    createCollectionList: async (req, ctx) => {
      const result = await handleCreateCollectionList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    updateCollectionList: async (req, ctx) => {
      const result = await handleUpdateCollectionList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    getCollectionList: async (req, ctx) => {
      const result = await handleGetCollectionList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    listCollectionLists: async (req, ctx) => {
      const result = await handleListCollectionLists(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    deleteCollectionList: async (req, ctx) => {
      const result = await handleDeleteCollectionList(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
  };

  contentStandards: ContentStandardsPlatform<TrainingGovernanceMeta> = {
    listContentStandards: async (req, ctx) => {
      const result = await handleListContentStandards(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    getContentStandards: async (req, ctx) => {
      const result = await handleGetContentStandards(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    createContentStandards: async (req, ctx) => {
      const result = await handleCreateContentStandards(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    updateContentStandards: async (req, ctx) => {
      const result = await handleUpdateContentStandards(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    calibrateContent: async (req, ctx) => {
      const result = await handleCalibrateContent(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    validateContentDelivery: async (req, ctx) => {
      const result = await handleValidateContentDelivery(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
  };
}
