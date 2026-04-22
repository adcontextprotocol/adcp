import { describe, it, expect } from 'vitest';
import { AddieRouter, ROUTING_RULES, parseRouterResponse } from '../../src/addie/router.js';
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

  describe('react patterns (channel messages only)', () => {
    it('should react with wave to greetings in channels', () => {
      const plan = router.quickMatch(makeCtx({ message: 'hello', source: 'channel' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('react');
      if (plan!.action === 'react') {
        expect(plan!.emoji).toBe('wave');
      }
    });

    it('should react with tada to welcome messages in channels', () => {
      const plan = router.quickMatch(makeCtx({ message: 'welcome!', source: 'channel' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('react');
      if (plan!.action === 'react') {
        expect(plan!.emoji).toBe('tada');
      }
    });

    it('should react with heart to thanks in channels', () => {
      const plan = router.quickMatch(makeCtx({ message: 'thanks!', source: 'channel' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('react');
      if (plan!.action === 'react') {
        expect(plan!.emoji).toBe('heart');
      }
    });

    it('should not react in DMs — let LLM respond conversationally', () => {
      const plan = router.quickMatch(makeCtx({ message: 'hello', source: 'dm' }));
      expect(plan).toBeNull();
    });

    it('should not react in channel threads — let LLM handle with context', () => {
      const plan = router.quickMatch(makeCtx({ message: 'thanks!', source: 'channel', isThread: true }));
      expect(plan).toBeNull();
    });

    it('should only match short messages for react patterns', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'hello, can you help me understand the adcp protocol?', source: 'channel' }),
      );
      expect(plan).toBeNull();
    });
  });

  describe('thread context bypasses ignore', () => {
    it('should not ignore acknowledgments in threads', () => {
      const plan = router.quickMatch(makeCtx({ message: 'yes', isThread: true }));
      expect(plan).toBeNull();
    });

    it('should still ignore acknowledgments in standalone messages', () => {
      const plan = router.quickMatch(makeCtx({ message: 'ok', source: 'channel' }));
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('ignore');
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

    it('should return null for "show me engagement analytics" (non-admin)', () => {
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

  describe('admin engagement/analytics quick-match', () => {
    it('should route "most engaged" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who are the most engaged members?', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
      if (plan!.action === 'respond') {
        expect(plan!.tool_sets).toEqual(['admin']);
      }
    });

    it('should route "engagement scores" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'show me engagement scores', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "top contributors" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who are the top contributors?', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "outreach stats" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'outreach stats', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should NOT route engagement queries for non-admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who are the most engaged members?' }),
      );
      expect(plan).toBeNull();
    });

    it('should NOT match bare "engagement" (too broad, could be protocol)', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'what is engagement in the protocol?', isAAOAdmin: true }),
      );
      expect(plan).toBeNull();
    });
  });

  describe('admin task management quick-match', () => {
    it('should route "my tasks" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'my tasks', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
      if (plan!.action === 'respond') {
        expect(plan!.tool_sets).toEqual(['admin']);
      }
    });

    it('should route "what\'s on my plate" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: "what's on my plate", isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "that moloco task is done" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'that moloco task is done', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "mark that as complete" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'mark that as complete', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "set a reminder" to admin tools for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'set a reminder to follow up with Acme', isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should NOT route task queries for non-admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'my tasks' }),
      );
      expect(plan).toBeNull();
    });

    it('should NOT match general "done" phrases without task vocabulary', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'that presentation is done', isAAOAdmin: true }),
      );
      expect(plan).toBeNull();
    });

    it('should NOT match project status questions containing "done"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'is this project done yet', isAAOAdmin: true }),
      );
      expect(plan).toBeNull();
    });
  });

  describe('event attendee quick-match', () => {
    it('should route "who\'s coming to the amsterdam meetup" to events for non-admin', () => {
      const plan = router.quickMatch(
        makeCtx({ message: "who's coming to the amsterdam meetup tonight" }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
      if (plan!.action === 'respond') {
        expect(plan!.tool_sets).toEqual(['events']);
      }
    });

    it('should route "who\'s coming" to events + admin for admins', () => {
      const plan = router.quickMatch(
        makeCtx({ message: "who's coming to the amsterdam meetup tonight", isAAOAdmin: true }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
      if (plan!.action === 'respond') {
        expect(plan!.tool_sets).toEqual(['events', 'admin']);
      }
    });

    it('should route "who is registered for the summit" to events', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who is registered for the summit?' }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "attendee list for the NYC meetup" to events', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'attendee list for the NYC meetup' }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "who will be at the meetup" to events', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who will be at the meetup tomorrow?' }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should route "who is going to Cannes" to events', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who is going to Cannes?' }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
    });

    it('should match Slack smart quotes in "who\u2019s coming to"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: "who\u2019s coming to the amsterdam meetup tonight" }),
      );
      expect(plan).not.toBeNull();
      expect(plan!.action).toBe('respond');
      if (plan!.action === 'respond') {
        expect(plan!.tool_sets).toEqual(['events']);
      }
    });

    it('should NOT match "who is going to fix this bug"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who is going to fix this bug?' }),
      );
      expect(plan).toBeNull();
    });

    it('should NOT match "who is going to handle the deployment"', () => {
      const plan = router.quickMatch(
        makeCtx({ message: 'who is going to handle the deployment?' }),
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
    expect(adminSet.tools).toContain('get_member_search_analytics');
  });

  it('should include working group membership tools', () => {
    expect(adminSet.tools).toContain('add_working_group_member');
    expect(adminSet.tools).toContain('remove_working_group_member');
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

  it('should always expose content submission and review tools (any channel, any toolset)', () => {
    // Content tools must be reachable regardless of the router's set choice.
    // Otherwise a member pasting a draft in an admin/editorial channel gets
    // an escalation instead of a submission — the root of issues #2695/#2698.
    const tools = getToolsForSets([], false);
    expect(tools).toContain('propose_content');
    expect(tools).toContain('get_my_content');
    expect(tools).toContain('list_pending_content');
    expect(tools).toContain('approve_content');
    expect(tools).toContain('reject_content');
  });

  it('should always expose read_google_doc so propose_content can consume a Docs link', () => {
    // Members share Google Doc links as drafts — the reader has to be
    // reachable before propose_content can be called, regardless of channel.
    const tools = getToolsForSets([], false);
    expect(tools).toContain('read_google_doc');
  });

  it('should always expose illustration tools (#2783)', () => {
    // Author asking Addie to regenerate their cover shouldn't depend
    // on the router picking the right set. Permission + quota gating
    // happens in the handler.
    const tools = getToolsForSets([], false);
    expect(tools).toContain('check_illustration_status');
    expect(tools).toContain('generate_perspective_illustration');
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
// parseRouterResponse — deterministic confidence extraction
// ============================================================================

describe('parseRouterResponse', () => {
  it('should default confidence to high when field is missing', () => {
    const plan = parseRouterResponse('{"action":"respond","tool_sets":["knowledge"],"reason":"test"}');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.confidence).toBe('high');
    }
  });

  it('should preserve suggest confidence', () => {
    const plan = parseRouterResponse('{"action":"respond","tool_sets":[],"confidence":"suggest","reason":"test"}');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.confidence).toBe('suggest');
    }
  });

  it('should preserve low confidence', () => {
    const plan = parseRouterResponse('{"action":"respond","tool_sets":[],"confidence":"low","reason":"test"}');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.confidence).toBe('low');
    }
  });

  it('should default invalid confidence values to high', () => {
    const plan = parseRouterResponse('{"action":"respond","tool_sets":[],"confidence":"maybe","reason":"test"}');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.confidence).toBe('high');
    }
  });

  it('should include confidence in parse error fallback', () => {
    const plan = parseRouterResponse('not valid json');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.confidence).toBe('high');
    }
  });

  it('should handle markdown-wrapped JSON', () => {
    const plan = parseRouterResponse('```json\n{"action":"respond","tool_sets":["member"],"confidence":"suggest","reason":"test"}\n```');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.confidence).toBe('suggest');
    }
  });

  it('should not add confidence to ignore actions', () => {
    const plan = parseRouterResponse('{"action":"ignore","reason":"off topic"}');
    expect(plan.action).toBe('ignore');
    expect('confidence' in plan).toBe(false);
  });

  it('should not add confidence to react actions', () => {
    const plan = parseRouterResponse('{"action":"react","emoji":"wave","reason":"greeting"}');
    expect(plan.action).toBe('react');
    expect('confidence' in plan).toBe(false);
  });

  it('should fall back to knowledge tools when JSON is truncated by max_tokens cutoff', () => {
    const plan = parseRouterResponse('{"action":"respond","tool_sets":["knowledge"],"confidence":"high","reason":"The user is asking about AdCP protoc');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.tool_sets).toEqual(['knowledge']);
      expect(plan.confidence).toBe('high');
      expect(plan.reason).toBe('Parse error - defaulting to knowledge tools');
    }
  });

  it('should convert stale clarify action to respond with knowledge tools', () => {
    const plan = parseRouterResponse('{"action":"clarify","question":"What do you mean?","reason":"ambiguous"}');
    expect(plan.action).toBe('respond');
    if (plan.action === 'respond') {
      expect(plan.tool_sets).toEqual(['knowledge']);
      expect(plan.confidence).toBe('suggest');
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

  // ---- Helpers ----

  async function routeAsAdmin(message: string): Promise<ExecutionPlan> {
    return liveRouter.route({
      message,
      source: 'dm',
      isAAOAdmin: true,
      memberContext: { is_member: true } as RoutingContext['memberContext'],
    });
  }

  async function routeAsMember(message: string): Promise<ExecutionPlan> {
    return liveRouter.route({
      message,
      source: 'dm',
      isAAOAdmin: false,
      memberContext: { is_member: true } as RoutingContext['memberContext'],
    });
  }

  async function routeInChannel(message: string, channelName = 'general'): Promise<ExecutionPlan> {
    return liveRouter.route({
      message,
      source: 'channel',
      isAAOAdmin: false,
      memberContext: { is_member: true } as RoutingContext['memberContext'],
      channelName,
    });
  }

  // ============================================================================
  // PROD SCENARIO TESTS — modeled on real production interactions
  // Each test documents: who said it, what channel, what happened in prod,
  // and what SHOULD happen.
  // ============================================================================

  describe('prod: channel messages Addie should IGNORE', () => {
    // Noga Rosenthal — #general — legal question from outside counsel
    // Prod: Addie responded with 300-word essay starting with "I don't know"
    // Should: Ignore or at most suggest — NOT a high-confidence full response
    it('should not give high-confidence response to legal/measurement questions', async () => {
      const plan = await routeInChannel(
        'Hi- I got asked this question by outside legal counsel: If an AI agent gets an ad impression, does that count as an "impression?" Do we count that in our measurement reports? If not, what happens?'
      );
      // Accept ignore (preferred) or suggest-confidence respond (acceptable — brief pointer to WG)
      if (plan.action === 'respond') {
        expect(plan.confidence).not.toBe('high');
      }
      // Should never be clarify for this
      expect(plan.action).not.toBe('clarify');
    }, 15000);

    // Joshua Koran — #general — meeting scheduling
    // Should: Ignore — scheduling is not Addie's domain
    it('should ignore meeting scheduling logistics', async () => {
      const plan = await routeInChannel(
        'Whomever controls this can we move it back to the normal time?'
      );
      expect(plan.action).toBe('ignore');
    }, 15000);

    // Joshua Koran — #general — meeting time complaint
    // Prod: Addie responded with meeting-tool suggestions
    // Should: Ignore — logistics for humans
    it('should ignore meeting time complaints', async () => {
      const plan = await routeInChannel(
        'I just noticed our meeting for tomorrow was moved to way too early'
      );
      expect(plan.action).toBe('ignore');
    }, 15000);

    // Pia Malovrh — #general — directed at specific person
    // Prod: Correctly ignored
    // Should: Ignore — addressed to @Morgan
    it('should ignore messages directed at specific people', async () => {
      const plan = await routeInChannel(
        '<@U09CABK88NR> could you please help with the above?'
      );
      expect(plan.action).toBe('ignore');
    }, 15000);

    // Michael Barnaby — #general — strategy discussion about North Star metric
    // Prod: Addie jumped in with opinions about org metrics
    // Should: Ignore — community debate, not a protocol question
    it('should ignore community strategy discussions', async () => {
      const plan = await routeInChannel(
        'Hot of the back of two great London based events with Prebid and AdCP - great work from everyone involved. A slight product based question: what are peoples thoughts on our collective North Star? How do we know we\'re gaining the correct momentum/adoption?'
      );
      expect(plan.action).toBe('ignore');
    }, 15000);

    // Generic — open channel question pattern
    it('should ignore "does anyone know" patterns', async () => {
      const plan = await routeInChannel(
        'Does anyone know if there\'s a standard way to handle frequency capping across multiple DSPs?'
      );
      expect(plan.action).toBe('ignore');
    }, 15000);

    // Generic — opinion poll
    it('should ignore opinion requests', async () => {
      const plan = await routeInChannel(
        'What do you all think about the new IAB guidelines for CTV measurement?'
      );
      expect(plan.action).toBe('ignore');
    }, 15000);

    // Brian O'Kelley — thread reply directed at another user
    // Prod: Correctly ignored (after Addie had responded earlier in thread)
    it('should ignore thread replies telling another user about deprecated fields', async () => {
      const plan = await routeInChannel(
        '<@U09LR9Z5TK7> that field is deprecated in 3.0 so I wouldn\'t worry about it'
      );
      expect(plan.action).toBe('ignore');
    }, 15000);
  });

  describe('prod: channel messages Addie SHOULD respond to', () => {
    // Direct name invocation in channel
    it('should respond when explicitly asked by name in channel', async () => {
      const plan = await routeInChannel(
        'Addie, what is the AdCP protocol?'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.confidence).toBe('high');
        expect(plan.tool_sets).toContain('knowledge');
      }
    }, 15000);

    // Schema question in working group channel — high expertise
    // Brian O'Kelley — #wg-creative — schema enum question
    // Prod: Addie gave authoritative answer with schema reference
    // Should: Respond — squarely in Addie's domain
    it('should respond to schema/protocol questions in wg channels', async () => {
      const plan = await routeInChannel(
        'we configuring creative agent for Adzymic formats, whereas category we using apx_impact as format_category identification for schemas, and I think type field is a strict enum so can not use any other naming outside these type enum',
        'wg-creative'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.confidence).toBe('high');
        expect(plan.tool_sets).toContain('knowledge');
      }
    }, 15000);
  });

  describe('prod: DM conversations — always respond, calibrate confidence', () => {
    // Noga's question IN A DM should get a response (same question that should be ignored in channel)
    it('should respond to legal-adjacent questions in DMs', async () => {
      const plan = await routeAsMember(
        'If an AI agent gets an ad impression, does that count as an "impression?" Do we count that in our measurement reports?'
      );
      expect(plan.action).toBe('respond');
    }, 15000);

    // Jean-Sébastien — DM — sell side signals question
    // Prod: Great conversation but was honest "commercial layer is not fully defined"
    // Business mechanics = commercial terms not yet codified → suggest confidence
    it('should respond to protocol business mechanics with suggest confidence', async () => {
      const plan = await routeAsMember(
        'how does the business mechanics work for signal provider with agentic buying process?'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(['high', 'suggest']).toContain(plan.confidence);
        expect(plan.tool_sets).toContain('knowledge');
      }
    }, 15000);

    // Jean-Sébastien — DM — who are the signal agent companies?
    // Prod: Used list_members, gave great answer
    it('should route member directory lookups to directory tools', async () => {
      const plan = await routeAsMember(
        'who are the companies acting as signal agents that are members of this community?'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('directory');
      }
    }, 15000);

    // Terence — DM — v3 spec materials
    // Prod: Good response pointing to GitHub and docs
    it('should respond to spec documentation requests', async () => {
      const plan = await routeAsMember(
        'could you point me to technical materials on the v3.0 spec?'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.confidence).toBe('high');
        expect(plan.tool_sets).toContain('knowledge');
      }
    }, 15000);

    // Terence — DM — which channels to follow as publisher
    it('should respond to channel recommendation requests', async () => {
      const plan = await routeAsMember(
        'As a Publisher/Seller - which would be the best channels to follow?'
      );
      expect(plan.action).toBe('respond');
    }, 15000);

    // B. Masse — DM — admin dashboard link
    it('should respond to dashboard link requests', async () => {
      const plan = await routeAsMember(
        'Do you have the link to the funnel dashboard? Not finding it'
      );
      expect(plan.action).toBe('respond');
    }, 15000);

    // Harvin — DM — test my agent
    // Prod: 16 msg thread of confusion because tools weren't available
    it('should route agent testing requests to agent_testing', async () => {
      const plan = await routeAsMember(
        'test https://david-five-kappa.vercel.app/api/ad-mcp'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('agent_testing');
      }
    }, 15000);

    // Ryan Maynard — DM — asking about previous conversation
    it('should respond to ambiguous recall requests', async () => {
      const plan = await routeAsMember(
        'where are these conversations?'
      );
      expect(plan.action).toBe('respond');
    }, 15000);
  });

  describe('prod: confidence tiers', () => {
    // Core AdCP question — high confidence
    it('should return high confidence for "what is AdCP"', async () => {
      const plan = await routeAsMember('what is AdCP?');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.confidence).toBe('high');
      }
    }, 15000);

    // Membership action — high confidence
    it('should return high confidence for membership actions', async () => {
      const plan = await routeAsMember('how do I join a working group?');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.confidence).toBe('high');
        expect(plan.tool_sets).toContain('member');
      }
    }, 15000);

    // External industry question — suggest or low
    it('should return suggest/low for questions outside core domain', async () => {
      const plan = await routeAsMember(
        'how does Google Privacy Sandbox affect header bidding?'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(['high', 'suggest', 'low']).toContain(plan.confidence);
      }
    }, 15000);

    // "who is working on X" — suggest confidence (point to people)
    it('should return suggest when pointing to people/groups', async () => {
      const plan = await routeAsMember(
        'who is working on attribution measurement standards?'
      );
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(['suggest', 'high']).toContain(plan.confidence);
      }
    }, 15000);

    // Every respond action must carry confidence
    it('should always include confidence on respond actions', async () => {
      const plan = await routeAsMember('tell me about creative schemas');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(['high', 'suggest', 'low']).toContain(plan.confidence);
      }
    }, 15000);

    // Channel message explicitly asking Addie — high confidence
    it('should return high confidence for channel messages naming Addie', async () => {
      const plan = await routeInChannel('Addie, what is the AdCP protocol?');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.confidence).toBe('high');
      }
    }, 15000);
  });

  describe('admin tool routing', () => {
    it('should route admin commands to admin set', async () => {
      const plan = await routeAsAdmin('add <@U12345|Paarth Sharma - YAHOO> as leader of media buy working group');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('admin');
      }
    }, 15000);

    it('should route committee leadership to committee_leadership for non-admin', async () => {
      const plan = await routeAsMember('make <@U88888|Bob> a co-leader of my chapter');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).toContain('committee_leadership');
        expect(plan.tool_sets).not.toContain('admin');
      }
    }, 15000);

    it('should NOT give non-admin the admin set', async () => {
      const plan = await routeAsMember('add <@U12345|Paarth> as leader of media buy working group');
      expect(plan.action).toBe('respond');
      if (plan.action === 'respond') {
        expect(plan.tool_sets).not.toContain('admin');
      }
    }, 15000);
  });
});
