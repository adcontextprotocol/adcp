import { describe, it, expect, beforeEach } from 'vitest';
import { loadRules, invalidateRulesCache } from '../../src/addie/rules/index.js';

describe('Rules Loader', () => {
  beforeEach(() => {
    invalidateRulesCache();
  });

  it('should load all five rule sections', () => {
    const rules = loadRules();

    expect(rules).toContain('# Core Identity');
    expect(rules).toContain('# Behaviors');
    expect(rules).toContain('# Knowledge');
    expect(rules).toContain('# Constraints');
    expect(rules).toContain('# Response Style');
  });

  it('should join sections with --- separators', () => {
    const rules = loadRules();
    const sections = rules.split('\n\n---\n\n');

    // Five hardcoded rule files + any injected sections (current-context,
    // expert-panel) loaded from .agents/ and .claude/agents/. Only the
    // minimum-five contract is load-bearing here.
    expect(sections.length).toBeGreaterThanOrEqual(5);
  });

  it('should include key rules from each section', () => {
    const rules = loadRules();

    // Identity
    expect(rules).toContain('## Core Mission');
    expect(rules).toContain('## Account Setup Priority');

    // Behaviors
    expect(rules).toContain('## Verify Claims With Tools');
    expect(rules).toContain('## Partner Directory');

    // Knowledge
    expect(rules).toContain('## Prebid Expertise');
    expect(rules).toContain('## Trusted Match Protocol (TMP)');

    // Constraints
    expect(rules).toContain('## No Speculative Answers');
    expect(rules).toContain('## Domain Focus - CRITICAL');

    // Response Style
    expect(rules).toContain('## Naming Conventions');
    expect(rules).toContain('## Concise and Helpful');
  });

  it('should contain accurate TMP and AXE references', () => {
    const rules = loadRules();

    // TMP is the current protocol, AXE is deprecated but documented
    expect(rules).toContain('Trusted Match Protocol (TMP)');
    expect(rules).toContain('AXE is deprecated');
    // AXE key-values (axei/axex/axem) are correct — they're the real key names
    expect(rules).toContain('axei');
    // Fake TMP key-values (tmpi/tmpx/tmpm) should NOT exist — they were never real
    expect(rules).not.toContain('tmpi');
    expect(rules).not.toContain('tmpx');
    expect(rules).not.toContain('tmpm');
  });

  it('should cache results across calls', () => {
    const first = loadRules();
    const second = loadRules();

    // Same reference means cached
    expect(first).toBe(second);
  });

  it('should re-read after cache invalidation', () => {
    const first = loadRules();
    invalidateRulesCache();
    const second = loadRules();

    // Content should be the same but it's a fresh read
    expect(first).toEqual(second);
  });
});
