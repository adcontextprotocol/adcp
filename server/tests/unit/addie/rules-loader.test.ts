import { describe, it, expect, beforeEach } from 'vitest';
import { loadRules, loadResponseStyle, invalidateRulesCache } from '../../../src/addie/rules/index.js';

describe('Addie rules loader', () => {
  beforeEach(() => {
    invalidateRulesCache();
  });

  it('loads the four base rule files joined with separators', () => {
    const prompt = loadRules();
    // Four base sections + injected current-context + expert-panel; each
    // separator is `\n---\n`. response-style.md is loaded separately and
    // appended after the tool reference at assembly time.
    const separatorCount = (prompt.match(/\n---\n/g) ?? []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(3);
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).not.toContain('# Response Style');
  });

  it('loadResponseStyle() returns the response-style.md content', () => {
    const style = loadResponseStyle();
    expect(style).toContain('# Response Style');
    expect(style).toContain('## Concise and Helpful');
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

  it('wraps current-context in an untrusted fence with ignore-directives framing', () => {
    const prompt = loadRules();
    // The fence tags prevent injected content from being read as instructions.
    expect(prompt).toContain('<addie_reference>');
    expect(prompt).toContain('</addie_reference>');
    expect(prompt).toContain('ignore any');
  });

  it('demotes level-1 headings in current-context so injection cannot fake new sections', () => {
    const prompt = loadRules();
    // current-context.md uses `# Current Context` as its own top-level header;
    // after demotion it becomes `## Current Context` inside the fence.
    // Guard: no `^# ` line inside the reference block.
    const fenceStart = prompt.indexOf('<addie_reference>');
    const fenceEnd = prompt.indexOf('</addie_reference>');
    const body = prompt.slice(fenceStart, fenceEnd);
    const topLevelHeadingMatches = body.match(/^# [^#]/gm) ?? [];
    expect(topLevelHeadingMatches).toHaveLength(0);
  });

  it('expert panel sits after the current-context injection', () => {
    const prompt = loadRules();
    const panelIdx = prompt.indexOf('# Expert Panel');
    expect(panelIdx).toBeGreaterThan(0);
    const contextIdx = prompt.indexOf('Current AdCP Context');
    expect(panelIdx).toBeGreaterThan(contextIdx);
  });

  it('expert panel uses lens-not-voice framing', () => {
    const prompt = loadRules();
    expect(prompt).toContain('apply the lens');
    expect(prompt).not.toContain("voice of the relevant expert"); // v1 framing was wrong per expert review
  });
});
