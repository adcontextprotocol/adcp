import { describe, expect, it } from 'vitest';
import {
  buildShadowEvalQueueContext,
  suppressedOpportunityFlagReason,
} from '../../../src/addie/jobs/shadow-replay-trace.js';

describe('shadow evaluation queue provenance', () => {
  it('queues only an immutable trace reference, never copied replay inputs', () => {
    const context = buildShadowEvalQueueContext(
      '00000000-0000-4000-8000-000000000001',
      new Date('2026-08-25T08:00:00.000Z'),
    );

    expect(context).toEqual({
      shadow_eval_status: 'pending',
      shadow_eval_requested_at: '2026-08-25T08:00:00.000Z',
      shadow_eval_type: 'suppressed_opportunity',
      shadow_eval_source: 'suppressed',
      shadow_eval_trace_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(Object.keys(context).some((key) => /question|user|channel|router|retrieval/.test(key)))
      .toBe(false);
  });

  it('uses categorical suppression flags without persisting router text', () => {
    const privateRouterReason = 'private.person@example.test asked about secret-client';
    const reasons = [
      suppressedOpportunityFlagReason('humans_already_answering'),
      suppressedOpportunityFlagReason('human_replied_during_delay'),
    ];

    expect(reasons).toEqual([
      'Suppressed high-confidence response (humans already answering)',
      'Suppressed high-confidence response (human replied during delay)',
    ]);
    expect(JSON.stringify(reasons)).not.toContain(privateRouterReason);
    expect(JSON.stringify(reasons)).not.toContain('private.person@example.test');
  });
});
