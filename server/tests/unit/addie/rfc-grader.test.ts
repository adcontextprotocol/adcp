/**
 * Unit tests for the RFC-drafting grader.
 *
 * Anchors on the failure mode the grader was built for: web-Addie drafted a
 * GitHub issue (Jeffrey Mayer / DanAds, 2026-05-01) without verifying the
 * gap against the spec; Slack-Addie later pushed back. Each test pins a
 * single dimension of the grade so a regression in one (e.g., the pushback
 * marker list shrinks) fails loud rather than masquerading as a router fix.
 */

import { describe, it, expect } from 'vitest';
import {
  gradeRfcRun,
  RFC_STUB_TOOLS,
  stubToolResult,
  type RfcExpectations,
  type RfcRunObservations,
} from '../../../src/addie/testing/rfc-grader.js';

const CPQ_EXPECT: RfcExpectations = {
  expectedToolSets: ['knowledge'],
  expectedToolCalls: ['search_docs'],
  expectedFieldCitations: ['pricing_options'],
  shouldRefusePremise: true,
};

describe('rfc-grader', () => {
  it('passes when verification ran, fields cited, and premise pushback is present', () => {
    const obs: RfcRunObservations = {
      routerToolSets: ['knowledge', 'content'],
      toolCalls: ['search_docs', 'get_schema'],
      finalText:
        "Most of this is already covered — pricing_options carries the firm rate, and buying_mode: refine handles iteration.",
      draftEmitted: false,
    };
    const grade = gradeRfcRun(CPQ_EXPECT, obs);
    expect(grade.passed).toBe(true);
    expect(grade.failures).toEqual([]);
  });

  it('flags the baseline failure: router missed knowledge, no search_docs, draft emitted, no pushback', () => {
    const obs: RfcRunObservations = {
      routerToolSets: ['content'],
      toolCalls: ['draft_github_issue'],
      finalText: 'Here is your pre-filled issue: …',
      draftEmitted: true,
    };
    const grade = gradeRfcRun(CPQ_EXPECT, obs);
    expect(grade.passed).toBe(false);
    expect(grade.routerOk).toBe(false);
    expect(grade.toolCallsOk).toBe(false);
    expect(grade.citationsOk).toBe(false);
    expect(grade.premiseOk).toBe(false);
    expect(grade.failures.length).toBe(4);
  });

  it('flags drafting-after-verifying as a premise failure when pushback is missing', () => {
    const obs: RfcRunObservations = {
      routerToolSets: ['knowledge'],
      toolCalls: ['search_docs', 'draft_github_issue'],
      finalText: 'Drafted as requested. pricing_options included in the body.',
      draftEmitted: true,
    };
    const grade = gradeRfcRun(CPQ_EXPECT, obs);
    expect(grade.routerOk).toBe(true);
    expect(grade.toolCallsOk).toBe(true);
    expect(grade.citationsOk).toBe(true);
    expect(grade.premiseOk).toBe(false);
    expect(grade.passed).toBe(false);
  });

  it('treats absent expectations as no-op (legacy scenarios still grade routing only)', () => {
    const grade = gradeRfcRun(
      {},
      {
        routerToolSets: [],
        toolCalls: [],
        finalText: '',
        draftEmitted: false,
      },
    );
    expect(grade.passed).toBe(true);
    expect(grade.failures).toEqual([]);
  });

  it('exposes stub tools matching the always-available + knowledge surface', () => {
    const names = RFC_STUB_TOOLS.map((t) => t.name);
    expect(names).toContain('search_docs');
    expect(names).toContain('get_schema');
    expect(names).toContain('draft_github_issue');
  });

  it('returns non-empty canned results for each stub so the model can continue', () => {
    for (const tool of RFC_STUB_TOOLS) {
      const out = stubToolResult(tool.name, {});
      expect(out.length).toBeGreaterThan(0);
      // Must be valid JSON — the multi-turn loop hands these back as
      // tool_result content and Anthropic will reject malformed payloads.
      expect(() => JSON.parse(out)).not.toThrow();
    }
  });
});
