import { AddieModelConfig, ModelConfig } from '../../config/models.js';
import {
  classifyProviderFailure,
  type ProviderFailureCategory,
} from './provider-errors.js';
import type {
  AddieExecutionMode,
} from './tool-orchestration.js';
import type {
  ModelFallbackReason,
  ModelProviderId,
  ModelResponse,
} from './model-provider.js';

export const MODEL_FALLBACK_DISCLOSURE_POLICY = 'server_metadata_only' as const;

export interface SiblingModelFallbackContext {
  provider: ModelProviderId;
  model: string;
  executionMode: AddieExecutionMode;
  iteration: number;
  retriesExhausted: boolean;
  isRecoveryInvocation: boolean;
  hasExecutedCustomTool: boolean;
  hasProviderContinuation: boolean;
  receivedDeltaCount: number;
  error: unknown;
  /** Deterministic policy injection for tests; production uses configured roles. */
  configuredModels?: SiblingModelFallbackModels;
}

export interface SiblingModelFallbackModels {
  primary: string;
  siblings: readonly string[];
}

export interface SiblingModelFallbackDecision {
  model: string;
  reason: ModelFallbackReason;
  disclosure: typeof MODEL_FALLBACK_DISCLOSURE_POLICY;
}

export type SiblingModelFallbackAttempt =
  | { status: 'not_selected' }
  | {
      status: 'succeeded';
      decision: SiblingModelFallbackDecision;
      response: ModelResponse;
    }
  | {
      status: 'failed';
      decision: SiblingModelFallbackDecision;
      error: unknown;
    };

const SAFE_FAILURE_REASONS: Partial<Record<ProviderFailureCategory, ModelFallbackReason>> = {
  rate_limited: 'primary_rate_limited',
  overloaded: 'primary_unavailable',
  timeout: 'primary_timeout',
  unavailable: 'primary_unavailable',
};

function configuredModels(): SiblingModelFallbackModels {
  return {
    primary: AddieModelConfig.chat,
    siblings: [
      ModelConfig.fast,
      AddieModelConfig.certification,
      AddieModelConfig.anonymousChat,
      AddieModelConfig.voice,
    ],
  };
}

/**
 * Select one same-provider fallback model before a logical turn has exposed or
 * executed any work. The production policy intentionally falls back only from
 * an eligible specialist model to Addie's primary chat model. Precision and
 * depth currently share one configured model ID, so that ID is deliberately
 * excluded: billing, financial, and legal turns must fail closed instead of
 * silently losing their accuracy-oriented model. The policy never moves
 * primary chat onto a more expensive or lower-quality sibling, never runs in
 * replay/shadow evaluation, and never retries billing/auth/request failures.
 *
 * Disclosure is server-metadata-only for both Slack and web. Injecting a UX
 * banner into one delivery mode would make otherwise identical responses
 * diverge and train users to infer model quality from transient infrastructure.
 * The persisted ModelExecution tuple remains authoritative for operations.
 */
export function selectSiblingModelFallback(
  context: SiblingModelFallbackContext,
): SiblingModelFallbackDecision | null {
  if (
    context.provider !== 'anthropic'
    || context.executionMode !== 'production'
    || context.iteration !== 1
    || !context.retriesExhausted
    || context.isRecoveryInvocation
    || context.hasExecutedCustomTool
    || context.hasProviderContinuation
    || context.receivedDeltaCount !== 0
  ) return null;

  const models = context.configuredModels ?? configuredModels();
  const fallbackModel = models.primary;
  if (
    context.model === fallbackModel
    || !new Set(models.siblings).has(context.model)
  ) return null;

  const failure = classifyProviderFailure(context.provider, context.error);
  const reason = SAFE_FAILURE_REASONS[failure.category];
  if (!reason) return null;

  return {
    model: fallbackModel,
    reason,
    disclosure: MODEL_FALLBACK_DISCLOSURE_POLICY,
  };
}

/**
 * Apply the shared fallback policy and invoke the selected model at most once.
 * The caller supplies its delivery-specific exactly-once transport boundary;
 * this function owns the common selected/succeeded/failed outcome contract.
 */
export async function attemptSiblingModelFallback(
  context: SiblingModelFallbackContext,
  invokeExactlyOnce: (model: string) => Promise<ModelResponse>,
): Promise<SiblingModelFallbackAttempt> {
  const decision = selectSiblingModelFallback(context);
  if (!decision) return { status: 'not_selected' };

  try {
    return {
      status: 'succeeded',
      decision,
      response: await invokeExactlyOnce(decision.model),
    };
  } catch (error) {
    return { status: 'failed', decision, error };
  }
}
