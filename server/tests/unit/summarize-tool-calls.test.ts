import { describe, it, expect } from 'vitest';
import { summarizeToolCalls } from '../../src/addie/prompts.js';

describe('summarizeToolCalls', () => {
  it('returns empty string for null', () => {
    expect(summarizeToolCalls(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(summarizeToolCalls(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(summarizeToolCalls([])).toBe('');
  });

  it('summarizes a single tool call', () => {
    const result = summarizeToolCalls([
      { name: 'search_repos', result: 'Found 3 results' },
    ]);
    expect(result).toContain('search_repos');
    expect(result).toContain('Found 3 results');
    expect(result).toContain('[Tool results from this turn:');
  });

  it('summarizes multiple tool calls', () => {
    const result = summarizeToolCalls([
      { name: 'search_docs', result: 'Doc A found' },
      { name: 'get_doc', result: 'Full content here' },
    ]);
    expect(result).toContain('search_docs');
    expect(result).toContain('get_doc');
  });

  it('marks errors', () => {
    const result = summarizeToolCalls([
      { name: 'search_repos', result: 'Invalid repo_id', is_error: true },
    ]);
    expect(result).toContain('search_repos(error)');
  });

  it('truncates long results at 200 characters', () => {
    const longResult = 'x'.repeat(300);
    const result = summarizeToolCalls([
      { name: 'search_repos', result: longResult },
    ]);
    expect(result).toContain('...');
    const hintMatch = result.match(/search_repos: (.+)/);
    expect(hintMatch).toBeTruthy();
    expect(hintMatch![1].length).toBeLessThanOrEqual(210);
  });

  it('handles non-string results by JSON-stringifying', () => {
    const result = summarizeToolCalls([
      { name: 'get_products', result: { items: ['a', 'b'] } },
    ]);
    expect(result).toContain('get_products');
    expect(result).toContain('"items"');
  });

  it('handles null result', () => {
    const result = summarizeToolCalls([
      { name: 'do_thing', result: null },
    ]);
    expect(result).toContain('do_thing');
    expect(result).not.toContain('null');
  });

  it('handles undefined result', () => {
    const result = summarizeToolCalls([
      { name: 'do_thing', result: undefined },
    ]);
    expect(result).toContain('do_thing');
  });

  it('caps total summary at 1000 characters', () => {
    // Create 10 tool calls each with 200-char results — would be ~2500 chars uncapped
    const calls = Array.from({ length: 10 }, (_, i) => ({
      name: `tool_${i}`,
      result: 'a'.repeat(200),
    }));
    const result = summarizeToolCalls(calls);
    // Strip the wrapper to measure just the tool summaries
    const inner = result.replace(/\n\n\[Tool results from this turn:\n/, '').replace(/\]$/, '');
    expect(inner.length).toBeLessThanOrEqual(1100); // some tolerance for tool names + formatting
    // Not all 10 tools should be included
    expect((result.match(/tool_/g) || []).length).toBeLessThan(10);
  });
});
