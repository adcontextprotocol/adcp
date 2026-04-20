import { describe, test, expect, vi } from 'vitest';

vi.mock('../../server/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { guardBareJsonEnvelope } from '../../server/src/addie/security.js';

describe('guardBareJsonEnvelope', () => {
  test('wraps a bare JSON object in a json code fence', () => {
    const input = '{"has_portrait": false, "reason": "not generated"}';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(true);
    expect(text.startsWith('```json\n')).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
    expect(text).toContain('"has_portrait"');
  });

  test('wraps a bare JSON array in a json code fence', () => {
    const input = '[{"id": 1}, {"id": 2}]';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(true);
    expect(text.startsWith('```json\n')).toBe(true);
  });

  test('wraps JSON with surrounding whitespace', () => {
    const input = '\n\n  {"ok": true}  \n';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(true);
    expect(text).toContain('"ok"');
  });

  test('leaves normal prose untouched', () => {
    const input = 'Here is your answer. The portrait has not been generated yet.';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(false);
    expect(text).toBe(input);
  });

  test('leaves markdown with embedded JSON untouched', () => {
    const input = 'Your portrait status:\n\n```json\n{"has_portrait": false}\n```';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(false);
    expect(text).toBe(input);
  });

  test('leaves responses that start with a code fence untouched', () => {
    const input = '```json\n{"foo": "bar"}\n```';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(false);
    expect(text).toBe(input);
  });

  test('leaves malformed JSON-looking text untouched', () => {
    const input = '{this is not valid json at all';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(false);
    expect(text).toBe(input);
  });

  test('leaves empty or single-char input untouched', () => {
    expect(guardBareJsonEnvelope('').wasWrapped).toBe(false);
    expect(guardBareJsonEnvelope('{').wasWrapped).toBe(false);
  });

  test('leaves prose that starts with a brace but is not JSON untouched', () => {
    const input = '{Not JSON} just using a brace stylistically.';
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(false);
    expect(text).toBe(input);
  });

  test('wraps a nested JSON envelope (simulates a stringified tool result)', () => {
    const input = JSON.stringify({
      type: 'tool_result',
      content: { members: [{ id: 'u1', name: 'Alice' }] },
    });
    const { text, wasWrapped } = guardBareJsonEnvelope(input);
    expect(wasWrapped).toBe(true);
    expect(text).toContain('"tool_result"');
    expect(text.startsWith('```json\n')).toBe(true);
  });
});
