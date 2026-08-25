import { createHash } from 'node:crypto';
import { AddieModelConfig, ModelConfig } from '../../config/models.js';
import { CODE_VERSION } from '../config-version.js';

export const SHADOW_EVAL_METADATA_VERSION = 1 as const;
export const SHADOW_EVALUATOR_VERSION = '2026.08.1' as const;

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
  };
  generator: ShadowEvalModelRef | null;
  judge: ShadowEvalModelRef | null;
  prompt: {
    evaluator_version: typeof SHADOW_EVALUATOR_VERSION;
    addie_code_version: string;
    generation_prompt_hash: string | null;
  };
  tools: {
    mode: 'descriptions_only' | 'production_trace' | 'replay_fixture' | 'none';
    requested_sets: string[];
    trace_or_fixture_id: string | null;
  };
  self_judged: boolean | null;
}

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
  generatorModel?: string | null;
  judgeModel?: string | null;
  promptHash?: string | null;
  toolMode: ShadowEvalProvenance['tools']['mode'];
  requestedToolSets?: string[];
  traceOrFixtureId?: string | null;
}): ShadowEvalProvenance {
  const sourceModel = input.sourceModel || null;
  const generatorModel = input.generatorModel || null;
  return {
    schema_version: SHADOW_EVAL_METADATA_VERSION,
    evaluation_type: input.evaluationType,
    source_answer: {
      kind: input.sourceKind,
      provider: sourceModel ? providerForModel(sourceModel) : null,
      model: sourceModel,
      config_version_id: input.sourceConfigVersionId ?? null,
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
    },
    self_judged: sourceModel && input.judgeModel
      ? sourceModel === input.judgeModel
      : null,
  };
}
