import { describe, it, expect, beforeEach } from 'vitest';
import { loadRules, invalidateRulesCache } from '../../src/addie/rules/index.js';
import { ADDIE_TOOL_REFERENCE } from '../../src/addie/prompts.js';

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

describe('Addie tool reference', () => {
  it('appends the auto-generated authoritative catalog', () => {
    expect(ADDIE_TOOL_REFERENCE).toContain('## Authoritative tool catalog (auto-generated)');
    // Catalog must list capability sets and a representative tool from each;
    // any of these going missing means the generator output drifted from
    // tool-sets.ts and the doc page is no longer the source of truth.
    expect(ADDIE_TOOL_REFERENCE).toContain('**knowledge**');
    expect(ADDIE_TOOL_REFERENCE).toContain('**agent_testing**');
    expect(ADDIE_TOOL_REFERENCE).toContain('evaluate_agent_quality');
    expect(ADDIE_TOOL_REFERENCE).toContain('search_docs');
  });

  it('catalog lands at the END of the assembled system prompt (claude-client concat order)', () => {
    // Mirror the concat in claude-client.ts:getSystemPrompt — base rules,
    // then `\n\n---\n\n`, then ADDIE_TOOL_REFERENCE. The catalog needs to be
    // the LAST section the model reads so its "treat every listed tool as
    // available" framing isn't undercut by earlier prose.
    const assembled = `${loadRules()}\n\n---\n\n${ADDIE_TOOL_REFERENCE}`;
    const catalogIdx = assembled.indexOf('## Authoritative tool catalog (auto-generated)');
    expect(catalogIdx).toBeGreaterThan(0);
    // Nothing of substance after the catalog (allow trailing whitespace).
    const tail = assembled.slice(catalogIdx);
    const lastNonEmptyLine = tail.split('\n').reverse().find(l => l.trim().length > 0);
    expect(lastNonEmptyLine).toMatch(/^[a-z_, ]+$/); // a flat tool list line, not prose
  });

  it('includes the honest-search-report rule', () => {
    const rules = loadRules();
    expect(rules).toContain('## Honest Reporting After Search');
    expect(rules).toContain("aren't loaded in this conversation");
  });

  it('every tool in the public docs page is also referenced in the prompt catalog', async () => {
    // The two outputs of build-addie-tool-reference share a registration
    // source but use different render paths (`render` for the docs page,
    // `renderCatalog` for the prompt). A silent filter divergence would let
    // one omit a tool the other includes. Invariant: every tool the docs
    // page renders as a heading must appear by name in the prompt catalog.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = path.resolve(__dirname, '../../..');
    const mdx = fs.readFileSync(path.join(repoRoot, 'docs/aao/addie-tools.mdx'), 'utf8');
    const catalog = fs.readFileSync(path.join(repoRoot, 'server/src/addie/generated/tool-catalog.generated.ts'), 'utf8');
    const mdxTools = Array.from(mdx.matchAll(/^### `([a-z_][a-z_0-9]*)`/gm)).map(m => m[1]);
    expect(mdxTools.length).toBeGreaterThan(50);
    const missing = mdxTools.filter(name => !new RegExp(`\\b${name}\\b`).test(catalog));
    expect(missing).toEqual([]);
  });
});
