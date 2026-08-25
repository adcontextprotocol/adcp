import { describe, expect, it } from 'vitest';
import {
  buildShadowEvalQueueContext,
  suppressedOpportunityFlagReason,
} from '../../../src/addie/jobs/shadow-replay-trace.js';
import {
  HUMAN_EVIDENCE_UNATTRIBUTABLE_REASON,
  findEarliestSubstantiveHumanReplyAfter,
  selectDelayedResponseDecision,
} from '../../../src/addie/bolt-app.js';

describe('shadow evaluation queue provenance', () => {
  it('queues only an immutable trace reference, never copied replay inputs', () => {
    const context = buildShadowEvalQueueContext(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      new Date('2026-08-25T08:00:00.000Z'),
    );

    expect(context).toEqual({
      shadow_eval_status: 'pending',
      shadow_eval_requested_at: '2026-08-25T08:00:00.000Z',
      shadow_eval_type: 'suppressed_opportunity',
      shadow_eval_source: 'suppressed',
      shadow_eval_trace_id: '00000000-0000-4000-8000-000000000001',
      shadow_eval_capture_attempt_id: '00000000-0000-4000-8000-000000000002',
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
    expect(HUMAN_EVIDENCE_UNATTRIBUTABLE_REASON).toBe('human_evidence_unattributable');
  });

  it('attributes only the exact earliest substantive post-question human reply', () => {
    const earlierReply = 'An older answer that belongs to a different question.';
    const earliestReply = '  The exact first attributable human answer.  ';
    const laterReply = 'A later answer that must never replace the first one.';
    const evidence = findEarliestSubstantiveHumanReplyAfter([
      { ts: '1000.100', user: 'U_OLD', text: earlierReply },
      { ts: '1000.500', user: 'U_LATER', text: laterReply },
      { ts: '1000.300', user: 'U_FIRST', text: earliestReply },
      { ts: '1000.200', user: 'U_SHORT', text: 'not substantive' },
      { ts: '1000.250', user: 'B_ADDIE', text: 'A bot answer that is long enough to look substantive.' },
      { ts: '1000.275', user: 'U_BOT', bot_id: 'BOT_OTHER', text: 'Another bot answer that must not count.' },
      { ts: '1000.280', user: 'U_BOT_SUBTYPE', subtype: 'bot_message', text: 'A bot subtype must not count as the first human reply.' },
    ], '1000.150', 'B_ADDIE');

    expect(evidence).toEqual({
      slackMessageTs: '1000.300',
      userId: 'U_FIRST',
      content: earliestReply,
    });
    expect(JSON.stringify(evidence)).not.toContain(earlierReply);
    expect(JSON.stringify(evidence)).not.toContain(laterReply);
  });

  it('uses inclusive UTF-8 byte bounds and rejects rather than truncating evidence', () => {
    const exactlyMinimumBytes = 'é'.repeat(10);
    const accepted = selectDelayedResponseDecision([
      { ts: '1000.200', user: 'U_FIRST', text: exactlyMinimumBytes },
    ], '1000.100', 'B_ADDIE');
    expect(accepted).toMatchObject({
      shouldRespond: false,
      humanEvidence: { content: exactlyMinimumBytes },
      humanEvidenceUnavailableReason: null,
    });

    const exactlyMaximumBytes = 'é'.repeat(750);
    expect(selectDelayedResponseDecision([
      { ts: '1000.200', user: 'U_FIRST', text: exactlyMaximumBytes },
    ], '1000.100', 'B_ADDIE')).toMatchObject({
      shouldRespond: false,
      humanEvidence: { content: exactlyMaximumBytes },
      humanEvidenceUnavailableReason: null,
    });

    const oversized = 'é'.repeat(751);
    const rejected = selectDelayedResponseDecision([
      { ts: '1000.200', user: 'U_FIRST', text: oversized },
      { ts: '1000.300', user: 'U_LATER', text: 'A later bounded answer must not be substituted.' },
    ], '1000.100', 'B_ADDIE');
    expect(rejected).toEqual({
      shouldRespond: false,
      humanEvidence: null,
      humanEvidenceUnavailableReason: 'human_evidence_too_large',
    });
    expect(JSON.stringify(rejected)).not.toContain(oversized);

    const invalidMetadata = selectDelayedResponseDecision([
      { ts: '1000.200', user: `U_${'x'.repeat(64)}`, text: exactlyMinimumBytes },
      { ts: '1000.300', user: 'U_LATER', text: 'A later bounded answer must not be substituted.' },
    ], '1000.100', 'B_ADDIE');
    expect(invalidMetadata).toEqual({
      shouldRespond: false,
      humanEvidence: null,
      humanEvidenceUnavailableReason: 'human_evidence_invalid',
    });
  });

  it('still suppresses Addie when a newer human reply is too short to judge', () => {
    expect(selectDelayedResponseDecision([
      { ts: '1000.200', user: 'U_HUMAN', text: 'Got it' },
    ], '1000.100', 'B_ADDIE')).toEqual({
      shouldRespond: false,
      humanEvidence: null,
      humanEvidenceUnavailableReason: 'human_evidence_not_substantive',
    });
  });

  it('still suppresses Addie for a human thread broadcast', () => {
    expect(selectDelayedResponseDecision([
      {
        ts: '1000.200',
        user: 'U_HUMAN',
        subtype: 'thread_broadcast',
        text: 'A substantive human reply also broadcast to the channel.',
      },
    ], '1000.100', 'B_ADDIE')).toEqual({
      shouldRespond: false,
      humanEvidence: null,
      humanEvidenceUnavailableReason: 'human_evidence_not_substantive',
    });
  });
});
