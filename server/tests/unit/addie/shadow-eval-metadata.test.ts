import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddieModelConfig, ModelConfig } from '../../../src/config/models.js';
import {
  buildShadowEvalProvenance,
  hasHeadlineEligibleProvenance,
  providerForModel,
  resolveShadowJudgeModel,
  shadowPromptHash,
} from '../../../src/addie/jobs/shadow-eval-metadata.js';

const originalJudgeModel = process.env.SHADOW_EVAL_JUDGE_MODEL;
const originalAllowSelfJudge = process.env.SHADOW_EVAL_ALLOW_SELF_JUDGE;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('shadow evaluation metadata', () => {
  beforeEach(() => {
    delete process.env.SHADOW_EVAL_JUDGE_MODEL;
    delete process.env.SHADOW_EVAL_ALLOW_SELF_JUDGE;
  });

  afterEach(() => {
    restoreEnv('SHADOW_EVAL_JUDGE_MODEL', originalJudgeModel);
    restoreEnv('SHADOW_EVAL_ALLOW_SELF_JUDGE', originalAllowSelfJudge);
  });

  it('defaults to a judge distinct from the fast shadow generator', () => {
    expect(resolveShadowJudgeModel([ModelConfig.fast])).not.toBe(ModelConfig.fast);
  });

  it('rejects an override that requests the source answer model', () => {
    process.env.SHADOW_EVAL_JUDGE_MODEL = AddieModelConfig.chat;
    expect(() => resolveShadowJudgeModel([AddieModelConfig.chat])).toThrow(
      'choose an independent judge',
    );
  });

  it('permits explicitly labelled self-judging experiments', () => {
    process.env.SHADOW_EVAL_JUDGE_MODEL = ModelConfig.fast;
    process.env.SHADOW_EVAL_ALLOW_SELF_JUDGE = 'true';
    expect(resolveShadowJudgeModel([ModelConfig.fast])).toBe(ModelConfig.fast);
  });

  it('resolves model aliases at the judge boundary', () => {
    process.env.SHADOW_EVAL_JUDGE_MODEL = 'primary';
    expect(resolveShadowJudgeModel()).toBe(AddieModelConfig.chat);
  });

  it('identifies supported providers without guessing unknown model names', () => {
    expect(providerForModel('claude-opus-5')).toBe('anthropic');
    expect(providerForModel('gpt-5.6-luna')).toBe('openai');
    expect(providerForModel('gemini-3.7-flash')).toBe('google');
    expect(providerForModel('future-model')).toBe('unknown');
  });

  it('creates a stable prompt identifier without persisting prompt content', () => {
    expect(shadowPromptHash('prompt A')).toBe(shadowPromptHash('prompt A'));
    expect(shadowPromptHash('prompt A')).not.toBe(shadowPromptHash('prompt B'));
    expect(shadowPromptHash('prompt A')).toHaveLength(16);
  });

  it('records source, generator, judge, tool mode, and self-judge status', () => {
    const provenance = buildShadowEvalProvenance({
      evaluationType: 'suppressed_opportunity',
      sourceKind: 'generated',
      sourceModel: ModelConfig.fast,
      generatorModel: ModelConfig.fast,
      judgeModel: ModelConfig.precision,
      toolMode: 'descriptions_only',
      requestedToolSets: ['knowledge', 'member', 'knowledge'],
    });

    expect(provenance).toMatchObject({
      schema_version: 2,
      evaluation_type: 'suppressed_opportunity',
      source_answer: {
        kind: 'generated',
        provider: 'anthropic',
        model: ModelConfig.fast,
        config_version_id: null,
        message_id: null,
      },
      source_question: { message_id: null },
      source_opportunity: { config_version_id: null },
      generator: { provider: 'anthropic', model: ModelConfig.fast },
      judge: { provider: 'anthropic', model: ModelConfig.precision },
      prompt: {
        evaluator_version: '2026.08.2',
        generation_prompt_hash: null,
      },
      tools: {
        mode: 'descriptions_only',
        requested_sets: ['knowledge', 'member'],
        trace_or_fixture_id: null,
        policy_version: null,
        hash_key_version: null,
        trace_verified: false,
        complete_fidelity: false,
        system_block_hashes: [],
        schemas: [],
        executions: [],
        blocked_capabilities: [],
      },
      self_judged: false,
    });
  });

  it('marks explicit same-model provenance as self-judged', () => {
    const provenance = buildShadowEvalProvenance({
      evaluationType: 'suppressed_opportunity',
      sourceKind: 'generated',
      sourceModel: ModelConfig.fast,
      generatorModel: ModelConfig.fast,
      judgeModel: ModelConfig.fast,
      toolMode: 'descriptions_only',
    });

    expect(provenance.self_judged).toBe(true);
  });

  it('keeps self-judge status unknown when the historical source model is unknown', () => {
    const provenance = buildShadowEvalProvenance({
      evaluationType: 'historical_corrected_answer',
      sourceKind: 'production',
      judgeModel: ModelConfig.precision,
      toolMode: 'production_trace',
      traceOrFixtureId: 'thread-id',
    });

    expect(provenance.source_answer.model).toBeNull();
    expect(provenance.self_judged).toBeNull();
  });

  it('fails closed for incomplete or blocked read-only replay evidence', () => {
    const provenance = buildShadowEvalProvenance({
      evaluationType: 'suppressed_opportunity',
      sourceKind: 'generated',
      sourceModel: AddieModelConfig.chat,
      sourceConfigVersionId: 42,
      sourceOpportunityConfigVersionId: 42,
      generatorModel: AddieModelConfig.chat,
      judgeModel: ModelConfig.precision,
      toolMode: 'read_only_replay',
      traceOrFixtureId: 'replay-1',
      replayEvidence: {
        complete_fidelity: true,
        blocked_capabilities: [],
        hash_key_version: 'test-key-v1',
        trace_verified: true,
        system_block_hashes: ['system-hash'],
        schemas: [{ name: 'search_docs', sha256: 'schema-hash', replay_safety: 'pure_local' }],
      },
    });

    expect(hasHeadlineEligibleProvenance(provenance)).toBe(true);
    expect(hasHeadlineEligibleProvenance({
      ...provenance,
      tools: { ...provenance.tools, blocked_capabilities: ['mutation:publish'] },
    })).toBe(false);
    expect(hasHeadlineEligibleProvenance({
      ...provenance,
      tools: { ...provenance.tools, complete_fidelity: false },
    })).toBe(false);
    expect(hasHeadlineEligibleProvenance({
      ...provenance,
      source_opportunity: { config_version_id: 41 },
    })).toBe(false);
  });
});
