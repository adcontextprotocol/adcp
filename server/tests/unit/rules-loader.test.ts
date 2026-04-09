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

    expect(sections.length).toBe(5);
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
    expect(rules).toContain('## AdCP Agent Types');
    expect(rules).toContain('## Prebid Expertise');
    expect(rules).toContain('## TMP Orchestrator Implementation');

    // Constraints
    expect(rules).toContain('## No Speculative Answers');
    expect(rules).toContain('## Domain Focus - CRITICAL');

    // Response Style
    expect(rules).toContain('## Naming Conventions');
    expect(rules).toContain('## Concise and Helpful');
  });

  it('should not contain deprecated AXE references', () => {
    const rules = loadRules();

    // AXE has been renamed to TMP
    expect(rules).not.toContain('AXE Orchestrator');
    expect(rules).not.toContain('axei');
    expect(rules).not.toContain('axex');
    expect(rules).not.toContain('axem');
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
