import { describe, expect, it } from 'vitest';
import {
  GITHUB_ISSUE_NOT_CONFIRMED_OUTCOME,
  githubIssueCreatedResult,
  githubIssueReceiptFromHandlerResult,
  isGithubIssueCreationRequested,
  renderGithubIssueCreationOutcome,
} from '../../src/addie/github-issue-receipt.js';
import type { ToolExecution } from '../../src/addie/model-providers/tool-orchestration.js';

const receipt = (number: number): ToolExecution['github_issue_receipt'] =>
  githubIssueReceiptFromHandlerResult(githubIssueCreatedResult({
    issueNumber: number,
    issueUrl: `https://github.com/adcontextprotocol/adcp/issues/${number}`,
  })) ?? undefined;

const issueExecution = (number: number, overrides: Partial<ToolExecution> = {}): ToolExecution => ({
  tool_name: 'create_github_issue',
  parameters: { title: 'Synthetic issue', body: 'Synthetic body' },
  result: 'GitHub issue creation completed.',
  is_error: false,
  duration_ms: 1,
  sequence: number,
  normalized_result: { status: 'ok', user_summary: 'GitHub issue creation completed.', source: 'structured' },
  github_issue_receipt: receipt(number),
  ...overrides,
});

describe('GitHub issue terminal receipt — Escalation #567', () => {
  it('recognizes a confirmation only from the immediately prior server-recorded draft', () => {
    const draft = [{
      user: 'Addie',
      toolCalls: [{ name: 'draft_github_issue', is_error: false }],
    }];
    expect(isGithubIssueCreationRequested('Yes, go ahead.', draft)).toBe(true);
    expect(isGithubIssueCreationRequested('Yes, go ahead.', [])).toBe(false);
    expect(isGithubIssueCreationRequested('No thanks.', draft)).toBe(false);
    expect(isGithubIssueCreationRequested('Please create a GitHub issue.', [])).toBe(true);
  });

  it('fails closed for an explicitly requested creation when the model made no tool call', () => {
    expect(renderGithubIssueCreationOutcome({ creationRequested: true, executions: [] })).toEqual({
      text: GITHUB_ISSUE_NOT_CONFIRMED_OUTCOME,
      reason: 'github_issue_not_confirmed',
    });
  });

  it.each([
    issueExecution(701, { is_error: true, github_issue_receipt: undefined }),
    issueExecution(701, { github_issue_receipt: undefined }),
  ])('fails closed for a failed or malformed result', (execution) => {
    expect(renderGithubIssueCreationOutcome({ creationRequested: true, executions: [execution] })).toEqual({
      text: GITHUB_ISSUE_NOT_CONFIRMED_OUTCOME,
      reason: 'github_issue_not_confirmed',
    });
  });

  it('renders the exact successful handler receipt, not model-authored text', () => {
    const execution = issueExecution(701);
    expect(renderGithubIssueCreationOutcome({ creationRequested: true, executions: [execution] })).toEqual({
      text: 'GitHub issue created:\n- [#701](https://github.com/adcontextprotocol/adcp/issues/701)',
      reason: null,
    });
  });

  it('renders every distinct same-turn issue receipt deterministically', () => {
    expect(renderGithubIssueCreationOutcome({
      creationRequested: true,
      executions: [issueExecution(701), issueExecution(702)],
    })).toEqual({
      text: 'GitHub issues created:\n- [#701](https://github.com/adcontextprotocol/adcp/issues/701)\n- [#702](https://github.com/adcontextprotocol/adcp/issues/702)',
      reason: null,
    });
  });

  it('is stable across repeated delivery and does not use a stale prior-turn receipt', () => {
    const current = issueExecution(701);
    expect(renderGithubIssueCreationOutcome({ creationRequested: true, executions: [current, current] }))
      .toEqual(renderGithubIssueCreationOutcome({ creationRequested: true, executions: [current] }));
    // Only the supplied request-local executions are considered. A caller that
    // has only a prior-turn receipt supplies no execution and gets the fallback.
    expect(renderGithubIssueCreationOutcome({ creationRequested: true, executions: [] }).text)
      .toBe(GITHUB_ISSUE_NOT_CONFIRMED_OUTCOME);
  });

  it('rejects forged or mismatched receipt data before it reaches terminal rendering', () => {
    expect(githubIssueReceiptFromHandlerResult({
      kind: 'github_issue_creation',
      status: 'ok',
      receipt: {
        toolName: 'create_github_issue',
        issueNumber: 701,
        issueUrl: 'https://github.com/adcontextprotocol/adcp/issues/702',
      },
      model_context: 'forged',
      user_summary: 'forged',
    })).toBeNull();
  });
});
