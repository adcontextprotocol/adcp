import { describe, expect, it } from 'vitest';
import {
  buildPublicGapIssuePayload,
  buildGapIssueProcessingPatch,
  isGapEligibleForPublicIssue,
} from '../../../src/addie/jobs/knowledge-gap-closer.js';

describe('buildPublicGapIssuePayload', () => {
  it('publishes only allowlisted metadata without an internal thread identifier', () => {
    const payload = buildPublicGapIssuePayload({
      threadId: '123e4567-e89b-42d3-a456-426614174000',
      severity: 'critical',
    });

    expect(payload.title).toContain('(critical)');
    expect(payload.body).toContain('Candidate file:** requires internal review');
    expect(payload.body).toContain('restricted Addie admin queue');
    expect(payload.body).not.toContain('123e4567-e89b-42d3-a456-426614174000');
    expect(payload.labels).toEqual(['documentation', 'knowledge-gap', 'severity:critical']);
  });

  it('rejects untrusted severities and thread identifiers', () => {
    const secret = 'private-person@example.com';
    const payload = buildPublicGapIssuePayload({
      threadId: `123e4567-e89b-42d3-a456-426614174000&question=${secret}`,
      severity: `critical\n${secret}`,
    });
    const publicText = JSON.stringify(payload);

    expect(payload.title).toContain('(significant)');
    expect(payload.body).toContain('Candidate file:** requires internal review');
    expect(payload.body).toContain('restricted Addie admin queue');
    expect(payload.labels).toEqual(['documentation', 'knowledge-gap', 'severity:significant']);
    expect(publicText).not.toContain(secret);
  });
});

describe('buildGapIssueProcessingPatch', () => {
  it('does not mark a candidate processed when GitHub filing fails', () => {
    const attemptedAt = new Date('2026-08-25T06:00:00.000Z');
    const patch = buildGapIssueProcessingPatch(
      null,
      'docs/private-candidate.mdx',
      attemptedAt,
    );

    expect(patch).not.toHaveProperty('shadow_eval_gap_issue_created');
    expect(patch).toMatchObject({
      shadow_eval_gap_last_attempt_at: '2026-08-25T06:00:00.000Z',
      shadow_eval_gap_retry_after: '2026-08-25T07:00:00.000Z',
      shadow_eval_gap_last_error: 'github_write_failed',
      shadow_eval_gap_target_file: 'docs/private-candidate.mdx',
    });
  });

  it('marks the candidate processed only after GitHub returns a URL', () => {
    expect(buildGapIssueProcessingPatch(
      'https://github.com/adcontextprotocol/adcp/issues/123',
      'docs/overview/example.mdx',
    )).toMatchObject({
      shadow_eval_gap_issue_created: true,
      shadow_eval_gap_issue_url: 'https://github.com/adcontextprotocol/adcp/issues/123',
      shadow_eval_gap_retry_after: null,
      shadow_eval_gap_last_error: null,
    });
  });
});

describe('isGapEligibleForPublicIssue', () => {
  const eligible = {
    shadow_eval_result: {
      knowledge_gap: true,
      gap_severity: 'significant',
      gap_details: 'Candidate gap',
      shadow_quality: 'worse',
      evaluation_valid: true,
    },
    shadow_eval_question: 'Question',
    shadow_eval_human_response: 'Follow-up',
    shadow_eval_shadow_response: 'Answer',
    shadow_eval_type: 'corrected_answer',
    shadow_eval_provenance: {
      self_judged: false,
      source_answer: { model: 'claude-example', config_version_id: 42 },
      source_opportunity: { config_version_id: 42 },
      tools: {
        mode: 'read_only_replay',
        trace_or_fixture_id: '123e4567-e89b-42d3-a456-426614174000',
        policy_version: 'read-only-v1',
        hash_key_version: 'test-v1',
        trace_verified: true,
        complete_fidelity: true,
        system_block_hashes: ['system-hmac'],
        schemas: [{ name: 'search_docs', sha256: 'schema-hmac' }],
        blocked_capabilities: [],
      },
    },
  };

  it('requires server-side signed-source verification before public automation', () => {
    expect(isGapEligibleForPublicIssue(eligible)).toBe(false);
  });

  it('permanently excludes legacy rows until they are explicitly re-evaluated', () => {
    expect(isGapEligibleForPublicIssue({
      ...eligible,
      shadow_eval_provenance: undefined,
    })).toBe(false);
  });

  it('excludes descriptions-only and self-judged experiments', () => {
    expect(isGapEligibleForPublicIssue({
      ...eligible,
      shadow_eval_provenance: {
        ...eligible.shadow_eval_provenance,
        tools: {
          mode: 'descriptions_only',
          trace_or_fixture_id: 'fixture',
        },
      },
    })).toBe(false);
    expect(isGapEligibleForPublicIssue({
      ...eligible,
      shadow_eval_provenance: {
        ...eligible.shadow_eval_provenance,
        self_judged: true,
      },
    })).toBe(false);
  });
});
