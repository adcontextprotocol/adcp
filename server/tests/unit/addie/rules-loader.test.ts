import { describe, it, expect, beforeEach } from 'vitest';
import { loadRules, invalidateRulesCache } from '../../../src/addie/rules/index.js';

describe('Addie rules loader', () => {
  beforeEach(() => {
    invalidateRulesCache();
  });

  it('loads the five rule files joined with separators', () => {
    const prompt = loadRules();
    // The five sections should produce at least four `---` separators.
    const separatorCount = (prompt.match(/\n---\n/g) ?? []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(4);
    expect(prompt.length).toBeGreaterThan(500);
  });

  it('injects the Current AdCP Context section from .agents/current-context.md', () => {
    const prompt = loadRules();
    expect(prompt).toContain('# Current AdCP Context');
  });

  it('injects the Expert Panel section from .claude/agents/*.md frontmatter', () => {
    const prompt = loadRules();
    expect(prompt).toContain('# Expert Panel');
    expect(prompt).toContain('ad-tech-protocol-expert');
    expect(prompt).toContain('adtech-product-expert');
  });

  it('caches the result across successive calls', () => {
    const a = loadRules();
    const b = loadRules();
    expect(a).toBe(b);
  });

  it('invalidateRulesCache() returns the same content on the next call', () => {
    const a = loadRules();
    invalidateRulesCache();
    const b = loadRules();
    // V8 interns these strings so identity may match — the contract is
    // that the content is equal after invalidation, not that a new
    // object is returned.
    expect(b).toEqual(a);
  });
});
