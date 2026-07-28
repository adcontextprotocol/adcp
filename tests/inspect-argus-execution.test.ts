import { describe, expect, it } from 'vitest';
import { inspectExecution } from '../.github/ai-review/inspect-execution.mjs';

describe('Argus execution inspection', () => {
  it('recovers a completed review and exposes denied tool calls', () => {
    const messages = [
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Request changes.\n\n## Things I checked\n- Trust boundary',
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'git status' } },
        ],
      },
    ];

    expect(inspectExecution(messages)).toEqual({
      completed: true,
      denials: messages[0].permission_denials,
      recoveryBody: messages[0].result,
    });
  });

  it('falls back to the final assistant message when the result omits the review', () => {
    const review = 'LGTM.\n\n## Things I checked\n- Schema and docs';
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: review }] } },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        permission_denials: [],
      },
    ];

    expect(inspectExecution(messages).recoveryBody).toBe(review);
  });

  it('does not recover errors or non-review final messages', () => {
    expect(inspectExecution([{
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: '## Things I checked\n- incomplete',
      permission_denials: [],
    }]).recoveryBody).toBeUndefined();

    expect(inspectExecution([{
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Analysis completed, but no review body was produced.',
      permission_denials: [],
    }]).recoveryBody).toBeUndefined();
  });
});
