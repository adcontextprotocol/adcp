import { describe, expect, it } from 'vitest';
import { buildShadowEvalQueueContext } from '../../../src/addie/bolt-app.js';

describe('shadow evaluation queue provenance', () => {
  it('captures source identity and the complete respond decision', () => {
    const context = buildShadowEvalQueueContext({
      plan: {
        action: 'respond',
        tool_sets: ['knowledge'],
        reason: 'Synthetic high-confidence fixture',
        confidence: 'high',
        decision_method: 'llm',
        model: 'router-model-example',
        latency_ms: 42,
        tokens_input: 10,
        tokens_output: 5,
        requires_precision: true,
        requires_depth: false,
      },
      channelId: 'C_SYNTHETIC',
      threadTs: '1000.0001',
      questionTs: '1000.0002',
      question: 'What does the public protocol documentation say?',
      sourceQuestionMessageId: '00000000-0000-4000-8000-000000000001',
      sourceUserId: 'U_SYNTHETIC',
      sourceConfigVersionId: 42,
      siRetrievalResult: { agents: [], retrieval_time_ms: 3 },
    });

    expect(context).toMatchObject({
      shadow_eval_status: 'pending',
      shadow_eval_channel_id: 'C_SYNTHETIC',
      shadow_eval_thread_ts: '1000.0001',
      shadow_eval_question_ts: '1000.0002',
      shadow_eval_source_question_message_id: '00000000-0000-4000-8000-000000000001',
      shadow_eval_source_user_id: 'U_SYNTHETIC',
      shadow_eval_source_config_version_id: 42,
      shadow_eval_router_decision: {
        action: 'respond',
        tool_sets: ['knowledge'],
        confidence: 'high',
        decision_method: 'llm',
        requires_precision: true,
        requires_depth: false,
      },
      shadow_eval_si_retrieval: { agents: [], retrieval_time_ms: 3 },
    });
  });
});
