import { createHash } from 'node:crypto';
import { AddieModelConfig, ModelConfig } from '../../config/models.js';
import { CODE_VERSION } from '../config-version.js';

export const SHADOW_EVAL_METADATA_VERSION = 2 as const;
export const SHADOW_EVALUATOR_VERSION = '2026.08.2' as const;
export const SHADOW_REPLAY_POLICY_VERSION = 'read-only-v1' as const;

export type ShadowEvalType =
  | 'suppressed_opportunity'
  | 'corrected_answer'
  | 'historical_corrected_answer';

export interface ShadowEvalModelRef {
  provider: 'anthropic' | 'openai' | 'google' | 'unknown';
  model: string;
}

export interface ShadowEvalProvenance {
  schema_version: typeof SHADOW_EVAL_METADATA_VERSION;
  evaluation_type: ShadowEvalType;
  source_answer: {
    kind: 'generated' | 'production';
    provider: ShadowEvalModelRef['provider'] | null;
    model: string | null;
    config_version_id: number | null;
    message_id: string | null;
  };
  source_question: {
    message_id: string | null;
  };
  source_opportunity: {
    config_version_id: number | null;
  };
  generator: ShadowEvalModelRef | null;
  judge: ShadowEvalModelRef | null;
  prompt: {
    evaluator_version: typeof SHADOW_EVALUATOR_VERSION;
    addie_code_version: string;
    generation_prompt_hash: string | null;
  };
  tools: {
    mode: 'descriptions_only' | 'production_trace' | 'replay_fixture' | 'read_only_replay' | 'none';
    requested_sets: string[];
    trace_or_fixture_id: string | null;
    policy_version: string | null;
    hash_key_version: string | null;
    trace_verified: boolean;
    complete_fidelity: boolean;
    system_block_hashes: string[];
    schemas: Array<{
      name: string;
      sha256: string;
      replay_safety: string | null;
    }>;
    executions: Array<{
      sequence: number;
      name: string;
      schema_sha256: string | null;
      input_sha256: string;
      result_sha256: string;
      disposition: 'live_read' | 'fixture_hit' | 'blocked_mutation' | 'blocked_unknown' | 'error';
    }>;
    blocked_capabilities: string[];
  };
  self_judged: boolean | null;
}

export type ShadowReplayEvidence = Pick<
  ShadowEvalProvenance['tools'],
  'complete_fidelity' | 'system_block_hashes' | 'schemas' | 'executions' | 'blocked_capabilities'
  | 'hash_key_version' | 'trace_verified'
>;

function resolveModelAlias(value: string): string {
  if (value === 'primary' || value === 'chat') return AddieModelConfig.chat;
  if (value === 'depth') return ModelConfig.depth;
  if (value === 'precision') return ModelConfig.precision;
  if (value === 'fast') return ModelConfig.fast;
  return value;
}

export function providerForModel(model: string): ShadowEvalModelRef['provider'] {
  if (model.startsWith('claude-')) return 'anthropic';
  if (/^(?:gpt-|o\d)/.test(model)) return 'openai';
  if (model.startsWith('gemini-')) return 'google';
  return 'unknown';
}

export function modelRef(model: string): ShadowEvalModelRef {
  return { provider: providerForModel(model), model };
}

export function shadowPromptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

/**
 * Resolve an evaluator model that is independent of the answer under review.
 *
 * `SHADOW_EVAL_JUDGE_MODEL` may use the same aliases as the generator model.
 * Exact-model self-judging is rejected by default even when an override asks
 * for it. Set SHADOW_EVAL_ALLOW_SELF_JUDGE=true only for an explicitly
 * labelled experiment; provenance makes those rows excludable from headline
 * metrics.
 */
export function resolveShadowJudgeModel(excludedModels: string[] = []): string {
  const excluded = new Set(excludedModels.filter(Boolean));
  const override = process.env.SHADOW_EVAL_JUDGE_MODEL?.trim();
  const preferred = resolveModelAlias(override || 'precision');
  const allowSelfJudge = process.env.SHADOW_EVAL_ALLOW_SELF_JUDGE === 'true';

  if (allowSelfJudge || !excluded.has(preferred)) return preferred;

  if (override) {
    throw new Error(
      `SHADOW_EVAL_JUDGE_MODEL resolves to excluded answer model ${preferred}; ` +
      'choose an independent judge or explicitly set SHADOW_EVAL_ALLOW_SELF_JUDGE=true',
    );
  }

  const independentFallback = [
    ModelConfig.precision,
    ModelConfig.depth,
    AddieModelConfig.chat,
    ModelConfig.fast,
  ].find((candidate) => !excluded.has(candidate));

  if (!independentFallback) {
    throw new Error(
      'No independent shadow-evaluation judge model is configured; ' +
      'set SHADOW_EVAL_JUDGE_MODEL to a model different from the answer model',
    );
  }
  return independentFallback;
}

export function buildShadowEvalProvenance(input: {
  evaluationType: ShadowEvalType;
  sourceKind: 'generated' | 'production';
  sourceModel?: string | null;
  sourceConfigVersionId?: number | null;
  sourceOpportunityConfigVersionId?: number | null;
  sourceMessageId?: string | null;
  sourceQuestionMessageId?: string | null;
  generatorModel?: string | null;
  judgeModel?: string | null;
  promptHash?: string | null;
  toolMode: ShadowEvalProvenance['tools']['mode'];
  requestedToolSets?: string[];
  traceOrFixtureId?: string | null;
  replayEvidence?: Partial<ShadowReplayEvidence>;
}): ShadowEvalProvenance {
  const sourceModel = input.sourceModel || null;
  const generatorModel = input.generatorModel || null;
  const completeByMode = input.toolMode === 'production_trace' || input.toolMode === 'replay_fixture';
  return {
    schema_version: SHADOW_EVAL_METADATA_VERSION,
    evaluation_type: input.evaluationType,
    source_answer: {
      kind: input.sourceKind,
      provider: sourceModel ? providerForModel(sourceModel) : null,
      model: sourceModel,
      config_version_id: input.sourceConfigVersionId ?? null,
      message_id: input.sourceMessageId ?? null,
    },
    source_question: {
      message_id: input.sourceQuestionMessageId ?? null,
    },
    source_opportunity: {
      config_version_id: input.sourceOpportunityConfigVersionId ?? null,
    },
    generator: generatorModel ? modelRef(generatorModel) : null,
    judge: input.judgeModel ? modelRef(input.judgeModel) : null,
    prompt: {
      evaluator_version: SHADOW_EVALUATOR_VERSION,
      addie_code_version: CODE_VERSION,
      generation_prompt_hash: input.promptHash ?? null,
    },
    tools: {
      mode: input.toolMode,
      requested_sets: [...new Set(input.requestedToolSets || [])].sort(),
      trace_or_fixture_id: input.traceOrFixtureId ?? null,
      policy_version: input.toolMode === 'read_only_replay'
        ? SHADOW_REPLAY_POLICY_VERSION
        : null,
      hash_key_version: input.replayEvidence?.hash_key_version ?? null,
      trace_verified: input.replayEvidence?.trace_verified ?? completeByMode,
      complete_fidelity: input.replayEvidence?.complete_fidelity ?? completeByMode,
      system_block_hashes: input.replayEvidence?.system_block_hashes ?? [],
      schemas: input.replayEvidence?.schemas ?? [],
      executions: input.replayEvidence?.executions ?? [],
      blocked_capabilities: input.replayEvidence?.blocked_capabilities ?? [],
    },
    self_judged: sourceModel && input.judgeModel
      ? sourceModel === input.judgeModel
      : null,
  };
}

/** Shared fail-closed gate for metrics and downstream automation. */
export function hasHeadlineEligibleProvenance(
  provenance: {
    self_judged?: boolean | null;
    source_answer?: { model?: string | null; config_version_id?: number | null };
    source_opportunity?: { config_version_id?: number | null };
    tools?: {
      mode?: string;
      trace_or_fixture_id?: string | null;
      policy_version?: string | null;
      complete_fidelity?: boolean;
      blocked_capabilities?: string[];
      system_block_hashes?: string[];
      schemas?: unknown[];
      hash_key_version?: string | null;
      trace_verified?: boolean;
    };
  } | null | undefined,
): boolean {
  if (!provenance || provenance.self_judged !== false) return false;
  const tools = provenance.tools;
  if (!provenance.source_answer?.model || !tools?.trace_or_fixture_id) return false;
  if (tools.mode === 'production_trace' || tools.mode === 'replay_fixture') {
    return tools.complete_fidelity !== false;
  }
  return tools.mode === 'read_only_replay'
    && typeof provenance.source_answer?.config_version_id === 'number'
    && typeof provenance.source_opportunity?.config_version_id === 'number'
    && provenance.source_answer.config_version_id === provenance.source_opportunity.config_version_id
    && tools.policy_version === SHADOW_REPLAY_POLICY_VERSION
    && Boolean(tools.hash_key_version)
    && tools.trace_verified === true
    && (tools.system_block_hashes?.length ?? 0) > 0
    && (tools.schemas?.length ?? 0) > 0
    && tools.complete_fidelity === true
    && tools.blocked_capabilities?.length === 0;
}
