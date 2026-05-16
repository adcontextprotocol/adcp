import { describe, test, expect } from 'vitest';
import { detectEmptyTurn } from '../../src/addie/claude-client.js';

type ToolExecution = {
  tool_name: string;
  tool_use_id: string;
  is_error?: boolean;
};

const ok = (tool: string): ToolExecution => ({
  tool_name: tool,
  tool_use_id: `tu_${tool}`,
  is_error: false,
});
const err = (tool: string): ToolExecution => ({
  tool_name: tool,
  tool_use_id: `tu_${tool}_err`,
  is_error: true,
});

describe('detectEmptyTurn (#3721)', () => {
  test('flags empty text + no tool calls — the silent-failure case', () => {
    expect(detectEmptyTurn('', [])).toMatch(/Empty turn/);
  });

  test('flags empty text + only errored tool calls (the actual repro)', () => {
    // Greg-thread shape: send_invoice was attempted, errored, and the model
    // produced no text. User saw nothing.
    expect(detectEmptyTurn('', [err('send_invoice')])).toMatch(/errored=1/);
  });

  test('does NOT flag when text is present, even with no tool calls', () => {
    expect(detectEmptyTurn('here is your answer', [])).toBeNull();
  });

  test('does NOT flag when at least one tool call succeeded', () => {
    // The user gets the tool result rendered downstream, not nothing.
    expect(detectEmptyTurn('', [ok('search_docs')])).toBeNull();
  });

  test('does NOT flag mixed success + error', () => {
    expect(detectEmptyTurn('', [ok('search_docs'), err('send_invoice')])).toBeNull();
  });

  test('reason includes counts so admins can debug from log lines', () => {
    const reason = detectEmptyTurn('', [err('a'), err('b'), err('c')]);
    expect(reason).toContain('toolExecutions=3');
    expect(reason).toContain('errored=3');
  });
});
