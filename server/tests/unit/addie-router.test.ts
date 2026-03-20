import { describe, it, expect } from 'vitest';
import { AddieRouter, ROUTING_RULES } from '../../src/addie/router.js';
import type { RoutingContext, ExecutionPlan } from '../../src/addie/router.js';
import {
  getToolSetDescriptionsForRouter,
  TOOL_SETS,
  getToolsForSets,
} from '../../src/addie/tool-sets.js';

/**
 * Addie Router Tests
 *
 * Tests the deterministic routing logic: quickMatch patterns, tool set
 * descriptions, and admin vs non-admin tool visibility.
 *
 * Does NOT test the LLM-based route() method — that requires a real
 * Anthropic API call and is exercised separately.
 */

// Use a dummy key — quickMatch never touches the Anthropic API
const router = new AddieRouter('sk-test-dummy-key');

function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    message: '',
    source: 'dm',
    ...overrides,
  };
}

// ============================================================================
// quickMatch — pattern-based fast routing
// ============================================================================

describe('AddieRouter.quickMatch', () => {
  describe('ignore patterns', () => {
    it('should ignore simple acknowledgments', () => {
      for (const ack of ['ok', 'okay', 'k', 'got it', 'cool', 'nice', 'lol']) {
        const plan = router.quickMatch(makeCtx({ message: ack }));
        expect(plan, `"${ack}" should be ignored`).not.toBeNull();
        expect(plan!.action).toBe('ignore');
        expect(plan!.decision_method).toBe('quick_match');
      }
    });

    it('should ignore acknowledgments with trailing period', () => {
      const plan = router.quickMatch(makeCtx({ message: 'ok.' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('ignore');
    });

    it('should be case-insensitive', () => {
      const plan = router.quickMatch(makeCtx({ message: 'OK' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('ignore');
    });
  });

  describe('react patterns', () => {
    it('should react with wave to greetings', () => {
      const plan = router.quickMatch(makeCtx({ message: 'hello' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('react');
      if (plan!.action === 'react') {
        expect(plan!.emoji).toBe('wave');
      }
    });

    it('should react with tada to welcome messages', () => {
      const plan = router.quickMatch(makeCtx({ message: 'welcome!' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('react');
      if (plan!.action === 'react') {
        expect(plan!.emoji).toBe('tada');
      }
    });

    it('should react with heart to thanks', () => {
      const plan = router.quickMatch(makeCtx({ message: 'thanks!' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('react');
      if (plan!.action === 'react') {
        expect(plan!.emoji).toBe('heart');
      }
    });

    it('should only match short messages for react patterns', () => {
      // Long message containing "hello" should not quick-match
      const plan = router.quickMatch(
        makeCtx({ message: 'hello, can you help me understand the adcp protocol?' }),
      );
      expect(plan).toBeNull();
    });
  });

  describe('admin commands must NOT be caught by quick patterns', () => {
    it('should return null for "add @Paarth as leader of media buy working group"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'add @Paarth as leader of media buy working group' }),
      );
      expect(plan).toBeNull();
    });

    it('should return null for "remove @Alice from the governance council"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'remove @Alice from the governance council' }),
      );
      expect(plan).toBeNull();
    });

    it('should return null for "list all working group leaders"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'list all working group leaders' }),
      );
      expect(plan).toBeNull();
    });

    it('should return null for "merge organizations Acme and Acme Corp"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'merge organizations Acme and Acme Corp' }),
      );
      expect(plan).toBeNull();
    });

    it('should return null for "show me engagement analytics"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'show me engagement analytics' }),
      );
      expect(plan).toBeNull();
    });

    it('should return null for "send an invoice to test@example.com"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'send an invoice to test@example.com' }),
      );
      expect(plan).toBeNull();
    });
  });

  describe('substantive messages fall through to LLM router', () => {
    it('should return null for protocol questions', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'how do I set up adagents.json?' }),
      );
      expect(plan).toBeNull();
    });

    it('should return null for membership questions', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'how do I join a working group?' }),
      );
      expect(plan).toBeNull();
    });

    it('should return null for multi-sentence messages', () => {
      const plan = router.quickMatch(
        makeCtx({
          message:
            'Hi! I am new to AdCP and want to understand the protocol. Can you help?',
        }),
      );
      expect(plan).toBeNull();
    });
  });
});

// ============================================================================
// Tool set descriptions for router — admin vs non-admin visibility
// ============================================================================

describe('getToolSetDescriptionsForRouter', () => {
  describe('non-admin user', () => {
    const descriptions = getToolSetDescriptionsForRouter(false);

    it('should include knowledge, member, directory sets', () => {
      expect(descriptions).toContain('knowledge');
      expect(descriptions).toContain('member');
      expect(descriptions).toContain('directory');
    });

    it('should NOT include admin set', () => {
      // admin is adminOnly: true
      expect(descriptions).not.toMatch(/\*\*admin\*\*/);
    });

    it('should NOT include billing set', () => {
      // billing is adminOnly: true
      expect(descriptions).not.toMatch(/\*\*billing\*\*/);
    });

    it('should NOT include outreach set', () => {
      // outreach is adminOnly: true
      expect(descriptions).not.toMatch(/\*\*outreach\*\*/);
    });
  });

  describe('admin user', () => {
    const descriptions = getToolSetDescriptionsForRouter(true);

    it('should include admin set', () => {
      expect(descriptions).toMatch(/\*\*admin\*\*/);
    });

    it('should include billing set', () => {
      expect(descriptions).toMatch(/\*\*billing\*\*/);
    });

    it('should include outreach set', () => {
      expect(descriptions).toMatch(/\*\*outreach\*\*/);
    });

    it('should still include non-admin sets', () => {
      expect(descriptions).toContain('knowledge');
      expect(descriptions).toContain('member');
      expect(descriptions).toContain('directory');
    });
  });
});

// ============================================================================
// Admin tool set contains committee/working group leadership tools
// ============================================================================

describe('TOOL_SETS.admin', () => {
  const adminSet = TOOL_SETS.admin;

  it('should exist and be marked adminOnly', () => {
    expect(adminSet).toBeDefined();
    expect(adminSet.adminOnly).toBe(true);
  });

  it('should include committee leadership tools', () => {
    expect(adminSet.tools).toContain('add_committee_leader');
    expect(adminSet.tools).toContain('remove_committee_leader');
    expect(adminSet.tools).toContain('list_committee_leaders');
  });

  it('should include working group tools', () => {
    expect(adminSet.tools).toContain('list_working_groups');
    expect(adminSet.tools).toContain('get_working_group');
    expect(adminSet.tools).toContain('rename_working_group');
  });

  it('should include engagement analytics tools', () => {
    expect(adminSet.tools).toContain('list_users_by_engagement');
    expect(adminSet.tools).toContain('get_insight_summary');
    expect(adminSet.tools).toContain('get_member_search_analytics');
  });

  it('should mention committee/working group leadership in description', () => {
    expect(adminSet.description).toMatch(/committee/i);
    expect(adminSet.description).toMatch(/working group/i);
    expect(adminSet.description).toMatch(/leadership/i);
  });
});

// ============================================================================
// getToolsForSets — admin gating
// ============================================================================

describe('getToolsForSets', () => {
  it('should include always-available tools even with empty set selection', () => {
    const tools = getToolsForSets([], false);
    expect(tools).toContain('escalate_to_admin');
    expect(tools).toContain('web_search');
  });

  it('should block admin tools for non-admin users', () => {
    const tools = getToolsForSets(['admin'], false);
    // Non-admin requesting admin set should get only always-available tools
    expect(tools).not.toContain('add_committee_leader');
    expect(tools).not.toContain('list_escalations');
  });

  it('should include admin tools for admin users', () => {
    const tools = getToolsForSets(['admin'], true);
    expect(tools).toContain('add_committee_leader');
    expect(tools).toContain('remove_committee_leader');
    expect(tools).toContain('list_escalations');
  });

  it('should block billing tools for non-admin users', () => {
    const tools = getToolsForSets(['billing'], false);
    expect(tools).not.toContain('create_payment_link');
    expect(tools).not.toContain('send_invoice');
  });

  it('should include billing tools for admin users', () => {
    const tools = getToolsForSets(['billing'], true);
    expect(tools).toContain('create_payment_link');
    expect(tools).toContain('send_invoice');
  });

  it('should combine multiple sets', () => {
    const tools = getToolsForSets(['knowledge', 'member'], false);
    expect(tools).toContain('search_docs');
    expect(tools).toContain('get_my_profile');
  });
});

// ============================================================================
// ROUTING_RULES integrity
// ============================================================================

describe('ROUTING_RULES', () => {
  it('should have ignore patterns that are all lowercase short strings', () => {
    for (const pattern of ROUTING_RULES.ignore.patterns) {
      expect(pattern).toBe(pattern.toLowerCase());
      expect(pattern.length).toBeLessThan(30);
    }
  });

  it('should not have overly broad ignore patterns like "."', () => {
    // A single dot pattern would match admin commands containing periods
    expect(ROUTING_RULES.ignore.patterns).not.toContain('.');
    expect(ROUTING_RULES.ignore.patterns).not.toContain('..');
  });

  it('should have react patterns that are all lowercase', () => {
    for (const [, rule] of Object.entries(ROUTING_RULES.reactWith)) {
      for (const pattern of rule.patterns) {
        expect(pattern).toBe(pattern.toLowerCase());
      }
    }
  });

  it('should have emoji names (not unicode) in react rules', () => {
    for (const [, rule] of Object.entries(ROUTING_RULES.reactWith)) {
      // Slack emoji names are alphanumeric with underscores, no colons
      expect(rule.emoji).toMatch(/^[a-z_]+$/);
    }
  });
});

// ============================================================================
// LLM Router — real Claude API calls to verify routing decisions
// Skip if no API key available (CI-safe)
// ============================================================================

const apiKey = process.env.ANTHROPIC_API_KEY;
const describeWithApi = apiKey ? describe : describe.skip;

describeWithApi('AddieRouter.route (LLM)', () => {
  const liveRouter = new AddieRouter(apiKey!);

  // Helper: route a message as an admin DM
  async function routeAsAdmin(message: string): Promise<ExecutionPlan> {
    return liveRouter.route({
      message,
      source: 'dm',
      isAAOAdmin: true,
      memberContext: { is_member: true } as RoutingContext['memberContext'],
    });
  }

  // Helper: route a message as a regular member DM
  async function routeAsMember(message: string): Promise<ExecutionPlan> {
    return liveRouter.route({
      message,
      source: 'dm',
      isAAOAdmin: false,
      memberContext: { is_member: true } as RoutingContext['memberContext'],
    });
  }

  describe('admin committee management commands', () => {
    it('should route "add @Paarth as leader of media buy working group" to admin', async () => {
      const plan = await routeAsAdmin('add <@U12345|Paarth Sharma - YAHOO> as leader of media buy working group');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('admin');
      }
    }, 15000);

    it('should route "remove @Alice from the governance council leadership" to admin', async () => {
      const plan = await routeAsAdmin('remove <@U99999|Alice> from the governance council leadership');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('admin');
      }
    }, 15000);

    it('should route "who are the leaders of the creative working group" to admin', async () => {
      const plan = await routeAsAdmin('who are the leaders of the creative working group?');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('admin');
      }
    }, 15000);

    it('should route "make @Bob a co-leader of my chapter" to committee_leadership for non-admin', async () => {
      const plan = await routeAsMember('make <@U88888|Bob> a co-leader of my chapter');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('committee_leadership');
        expect(plan.tool_sets).not.toContain('admin');
      }
    }, 15000);
  });

  describe('should not route admin commands for non-admin users to admin set', () => {
    it('should NOT give non-admin user the admin set for "add @X as leader"', async () => {
      const plan = await routeAsMember('add <@U12345|Paarth> as leader of media buy working group');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).not.toContain('admin');
      }
    }, 15000);
  });

  describe('membership and protocol questions', () => {
    it('should route "how do I join a working group" to member', async () => {
      const plan = await routeAsMember('how do I join a working group?');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('member');
      }
    }, 15000);

    it('should route "what is AdCP" to knowledge', async () => {
      const plan = await routeAsMember('what is AdCP?');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('knowledge');
      }
    }, 15000);
  });
});
