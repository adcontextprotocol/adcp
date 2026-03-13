import { getToolsForSets, ALWAYS_AVAILABLE_TOOLS, TOOL_SETS } from '../../server/src/addie/tool-sets.js';

describe('getToolsForSets', () => {
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
});
