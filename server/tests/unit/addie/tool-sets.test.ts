import { describe, it, expect } from 'vitest';
import { getToolsForSets, ALWAYS_AVAILABLE_TOOLS, ALWAYS_AVAILABLE_ADMIN_TOOLS, TOOL_SETS, buildUnavailableSetsHint } from '../../../src/addie/tool-sets.js';

describe('getToolsForSets', () => {
  describe('admin always-available tools', () => {
    it('includes resolve_escalation for admins without admin set routed', () => {
      const tools = getToolsForSets(['knowledge'], true, false);
      expect(tools).toContain('resolve_escalation');
      expect(tools).toContain('list_escalations');
    });

    it('excludes resolve_escalation for non-admins', () => {
      const tools = getToolsForSets(['knowledge'], false, false);
      expect(tools).not.toContain('resolve_escalation');
    });

    it('includes admin always-available tools even with no sets selected', () => {
      const tools = getToolsForSets([], true, false);
      for (const tool of ALWAYS_AVAILABLE_ADMIN_TOOLS) {
        expect(tools).toContain(tool);
      }
    });
  });

  describe('public channel filtering', () => {
    it('excludes get_account_link from always-available tools in public channels', () => {
      const tools = getToolsForSets([], false, true);
      expect(tools).not.toContain('get_account_link');
    });

    it('includes get_account_link in private channels', () => {
      const tools = getToolsForSets([], false, false);
      expect(tools).toContain('get_account_link');
    });

    it('includes get_account_link by default', () => {
      const tools = getToolsForSets([]);
      expect(tools).toContain('get_account_link');
    });

    it('skips billing tool set in public channels', () => {
      const billingTools = TOOL_SETS.billing.tools;
      const tools = getToolsForSets(['billing'], true, true);
      for (const billingTool of billingTools) {
        expect(tools).not.toContain(billingTool);
      }
    });

    it('includes billing tool set in private channels for admins', () => {
      const tools = getToolsForSets(['billing'], true, false);
      expect(tools).toContain('find_membership_products');
    });

    it('still includes non-enrollment always-available tools in public channels', () => {
      const tools = getToolsForSets([], false, true);
      expect(tools).toContain('escalate_to_admin');
      expect(tools).toContain('capture_learning');
    });

    it('still includes knowledge tools in public channels', () => {
      const tools = getToolsForSets(['knowledge'], false, true);
      expect(tools).toContain('search_docs');
    });
  });

  describe('github issue tools always available', () => {
    it('includes draft_github_issue regardless of routed sets', () => {
      const tools = getToolsForSets(['knowledge'], false, false);
      expect(tools).toContain('draft_github_issue');
    });

    it('includes create_github_issue regardless of routed sets', () => {
      const tools = getToolsForSets(['knowledge'], false, false);
      expect(tools).toContain('create_github_issue');
    });

    it('includes github issue tools in public channels', () => {
      const tools = getToolsForSets([], false, true);
      expect(tools).toContain('draft_github_issue');
      expect(tools).toContain('create_github_issue');
    });
  });

  describe('content set description does not claim ownership of github issuing', () => {
    it('omits "draft GitHub issues" from the description', () => {
      expect(TOOL_SETS.content.description).not.toMatch(/github issue/i);
    });
  });
});

describe('buildUnavailableSetsHint', () => {
  it('returns empty when all sets are selected', () => {
    const allSets = Object.keys(TOOL_SETS);
    expect(buildUnavailableSetsHint(allSets, true)).toBe('');
  });

  it('lists an always-available escape-hatch section when sets are unavailable', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    expect(hint).toContain('Always Available');
    expect(hint).toContain('draft_github_issue');
    expect(hint).toContain('create_github_issue');
    expect(hint).toContain('escalate_to_admin');
  });

  it('never describes the content set as owning GitHub issue filing', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    const contentSection = hint.match(/- \*\*content\*\*:[^\n]*/)?.[0] ?? '';
    expect(contentSection).not.toMatch(/github issue/i);
  });

  it('never advertises tools that are not actually in ALWAYS_AVAILABLE_TOOLS (drift guard)', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    // Extract tool names from the "Always Available" section: lines of the
    // form `- <tool_name> — blurb`.
    const section = hint.split('## Capabilities That ARE Always Available')[1] ?? '';
    const advertised = [...section.matchAll(/^- (\w+) — /gm)].map((m) => m[1]);
    expect(advertised.length).toBeGreaterThan(0);
    for (const tool of advertised) {
      expect(
        ALWAYS_AVAILABLE_TOOLS,
        `Hint advertised "${tool}" as always-available but it is not in ALWAYS_AVAILABLE_TOOLS`,
      ).toContain(tool);
    }
  });
});
