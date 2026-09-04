import { describe, expect, it, vi } from 'vitest';
import type {
  ModelProvider,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
} from '../../../src/addie/model-providers/model-provider.js';
import {
  buildRouterEvalRequest,
  evaluateRouterCase,
  MODEL_ROUTER_CORPUS,
  parseStrictRouterPlan,
  RouterPlanParseError,
  scoreRouterPlan,
  shouldDispatchWithinSoftBudget,
  accountRouterCallCostUsd,
  runRouterEvalMatrix,
  summarizeRouterEval,
  SYNTHETIC_ROUTER_CORPUS,
} from '../../../src/addie/testing/provider-router-eval.js';
import {
  AddieRouter,
  buildRouterModelRequest,
  buildRoutingPrompt,
} from '../../../src/addie/router.js';
import { getValidToolSetNames } from '../../../src/addie/tool-sets.js';

function fakeProvider(text: string | string[], finishReason: 'stop' | 'length' | 'refusal' = 'stop'): ModelProvider {
  return {
    id: 'openai',
    capabilities: {
      streaming: false,
      structuredOutput: true,
      reasoning: false,
      reasoningEfforts: ['provider_default'],
      customTools: false,
      providerWebSearch: false,
      imageInput: false,
      documentInput: false,
    },
    prepare: (request) => ({
      provider: 'openai',
      model: request.model,
      capabilities: {
        streaming: false,
        structuredOutput: true,
        reasoning: false,
        reasoningEfforts: ['provider_default'],
        customTools: false,
        providerWebSearch: false,
        imageInput: false,
        documentInput: false,
      },
      providerRequest: { model: request.model, marker: 'actual-dispatch' },
    }),
    async *respond(request: ModelRequest, options?: ModelRespondOptions): AsyncIterable<NormalizedModelEvent> {
      await options?.beforeDispatch?.(this.prepare(request));
      const textBlocks = Array.isArray(text) ? text : text ? [text] : [];
      yield { type: 'response_start', provider: 'openai', model: request.model, id: 'id' };
      for (const [index, block] of textBlocks.entries()) {
        yield { type: 'text_delta', index, text: block };
      }
      yield {
        type: 'response_complete',
        response: {
          provider: 'openai', model: request.model, id: 'id',
          content: textBlocks.map((block) => ({ type: 'text' as const, text: block })),
          finishReason, providerFinishReason: finishReason,
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      };
    },
  };
}

describe('strict router eval', () => {
  it('returns the production plan even when its detached observer rejects', async () => {
    const provider = fakeProvider(
      '{"action":"ignore","reason":"authoritative"}',
    );
    const observer = vi.fn(async () => {
      throw new Error('shadow failed');
    });
    const plan = await new AddieRouter('unused', provider).route(
      { message: 'route this', source: 'channel' },
      { observer },
    );
    expect(plan).toMatchObject({ action: 'ignore', reason: 'authoritative' });
    expect(observer).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observer).toHaveBeenCalledOnce();
  });

  it('observes the exact primary request and terminal provider failure without changing fallback', async () => {
    const provider = fakeProvider('unused');
    provider.respond = async function* (request, options) {
      await options?.beforeDispatch?.(this.prepare(request));
      throw new Error('private provider failure');
    };
    const observer = vi.fn();
    const plan = await new AddieRouter('unused', provider).route(
      { message: 'route failure safely', source: 'channel' },
      { observer },
    );
    expect(plan).toMatchObject({
      action: 'respond',
      tool_sets: ['knowledge', 'community_research', 'schema_reference'],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      requestedProvider: 'openai',
      returnedProvider: null,
      primaryErrorCategory: 'provider_error',
      primaryInvocation: expect.objectContaining({
        provider: 'openai',
        providerRequest: expect.objectContaining({ marker: 'actual-dispatch' }),
      }),
      canonicalRequest: expect.objectContaining({
        model: 'claude-haiku-4-5',
        tools: [],
      }),
    }));
  });

  it('uses the exact production request for the prompt-parity profile', () => {
    const testCase = MODEL_ROUTER_CORPUS[0];
    expect(buildRouterEvalRequest('router-model', 'prompt_parity', testCase))
      .toEqual(buildRouterModelRequest(testCase.context, 'router-model'));
  });

  it('scores only the first response block, matching production routing', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'off-topic')!;
    const result = await evaluateRouterCase(fakeProvider([
      '{"action":"ignore","reason":"first block wins"}',
      '{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"ignored"}',
    ]), 'router-model', 'prompt_parity', testCase);

    expect(result.status).toBe('valid_plan');
    expect(result.plan).toEqual({ action: 'ignore', reason: 'first block wins' });
    expect(result.scores.actionExact).toBe(true);
  });

  it('uses a frozen synthetic corpus covering every tool set', () => {
    expect(SYNTHETIC_ROUTER_CORPUS).toHaveLength(106);
    expect(new Set(SYNTHETIC_ROUTER_CORPUS.map((testCase) => testCase.id)).size).toBe(106);
    const expectedSets = new Set(SYNTHETIC_ROUTER_CORPUS.flatMap((testCase) => testCase.expected.toolSets ?? []));
    expect(expectedSets).toEqual(new Set([
      'knowledge', 'member_profile', 'community_group_discovery', 'community_group_membership', 'council_interest', 'community_group_contribution', 'community_group_full_participation', 'partner_directory', 'agent_publisher_directory', 'brand_registry_records', 'brand_registry_identity', 'agent_registry', 'agent_quality', 'agent_authentication', 'agent_end_to_end', 'property_registry_records', 'property_list_enrichment', 'property_identifier_catalog', 'agent_conformance',
      'adcp_operations', 'sponsored_intelligence', 'content',
      'publishing_author', 'publishing_review', 'publishing_promotion', 'github', 'illustrations',
      'community_research', 'schema_reference',
      'member_billing', 'admin_billing_payments', 'admin_billing_discounts', 'admin_billing_account',
      'events', 'meeting_attendance', 'meeting_scheduling', 'meeting_series_topics', 'meeting_full_administration',
      'committee_leadership', 'admin_events', 'admin_prospect_pipeline', 'admin_prospect_research', 'admin_feed_monitoring', 'admin_feed_curation',
      'admin_group_structure', 'admin_group_leadership', 'admin_group_membership',
      'admin_organization_integrity', 'admin_organization_member_records', 'admin_conversation_review', 'admin_followup_tasks',
      'admin_brand_registry_integrity', 'admin_brand_logo_review',
      'outreach', 'collaboration',
      'certification_overview', 'certification_learning', 'certification_assessment',
    ]));
    const productionRouter = new AddieRouter('unused');
    expect(MODEL_ROUTER_CORPUS).toHaveLength(105);
    for (const testCase of MODEL_ROUTER_CORPUS) {
      expect(productionRouter.quickMatch(testCase.context), testCase.id).toBeNull();
    }
    expect(expectedSets).not.toContain('agent_validation');
    expect(expectedSets).not.toContain('property_catalog');
    expect(expectedSets).not.toContain('meetings');
    expect(expectedSets).not.toContain('community_groups');
    expect(expectedSets).not.toContain('directory');
    expect(expectedSets).not.toContain('brand_registry');
    expect(expectedSets).not.toContain('admin_organizations');
    expect(expectedSets).not.toContain('admin_brands');
    expect(expectedSets).not.toContain('billing');
    expect(expectedSets).not.toContain('admin_prospects');
    expect(expectedSets).not.toContain('admin_feeds');
    expect(expectedSets).not.toContain('admin_workflows');
  });

  it('selects only the bounded directory domain needed by an ordinary request', async () => {
    const partner = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'directory-vendor')!;
    const agentPublisher = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'directory-agent-publisher')!;
    const partnerResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["partner_directory"],"confidence":"high","requires_depth":false,"reason":"partner lookup"}',
    ), 'router-model', 'prompt_parity', partner);
    const agentPublisherResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["agent_publisher_directory"],"confidence":"high","requires_depth":false,"reason":"agent and publisher lookup"}',
    ), 'router-model', 'prompt_parity', agentPublisher);

    expect(partnerResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(agentPublisherResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
  });

  it('grades the documented dual-domain directory case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'directory-partner-and-agent')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["agent_publisher_directory","partner_directory"],"confidence":"high","requires_depth":true,"reason":"partner plus agent lookup"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["partner_directory"],"confidence":"high","requires_depth":true,"reason":"incomplete directory selection"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual(['partner_directory', 'agent_publisher_directory']);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('selects only the bounded brand-registry domain needed by an ordinary request', async () => {
    const records = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'brand-registry-records')!;
    const identity = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'brand-registry-identity')!;
    const recordsResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["brand_registry_records"],"confidence":"high","requires_depth":false,"reason":"registry records"}',
    ), 'router-model', 'prompt_parity', records);
    const identityResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["brand_registry_identity"],"confidence":"high","requires_depth":false,"reason":"canonical identity"}',
    ), 'router-model', 'prompt_parity', identity);

    expect(recordsResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(identityResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
  });

  it('grades the documented dual-domain brand-registry case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'brand-registry-records-and-identity')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["brand_registry_identity","brand_registry_records"],"confidence":"high","requires_depth":true,"reason":"record plus canonical identity"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["brand_registry_identity"],"confidence":"high","requires_depth":true,"reason":"incomplete workflow selection"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual(['brand_registry_records', 'brand_registry_identity']);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('selects the exact full meeting union for a long three-workflow request', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'meeting-full-administration')!;
    const result = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["meeting_full_administration"],"confidence":"high","requires_depth":true,"reason":"one long cross-workflow meeting request"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(result.plan).toMatchObject({
      action: 'respond',
      tool_sets: ['meeting_full_administration'],
      requires_depth: true,
    });
    expect(result.scores).toMatchObject({ actionExact: true, toolsExact: true });
  });

  it('selects the exact full community-group union only for long three- or four-workflow requests', async () => {
    const threeWorkflow = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'community-group-three-workflow-participation')!;
    const allWorkflows = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'community-group-full-participation')!;
    const result = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["community_group_full_participation"],"confidence":"high","requires_depth":true,"reason":"one long cross-workflow group request"}',
    ), 'router-model', 'prompt_parity', threeWorkflow);
    const allResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["community_group_full_participation"],"confidence":"high","requires_depth":true,"reason":"one long all-workflow group request"}',
    ), 'router-model', 'prompt_parity', allWorkflows);

    expect(result.plan).toMatchObject({
      action: 'respond',
      tool_sets: ['community_group_full_participation'],
      requires_depth: true,
    });
    expect(result.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(allResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
  });

  it('keeps one- and two-workflow community requests on their narrow domains', async () => {
    const membership = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'community-group-membership')!;
    const bookmark = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'community-group-bookmark-resource')!;
    const paired = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'community-group-discovery-membership')!;
    const membershipResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["community_group_membership"],"confidence":"high","requires_depth":false,"reason":"membership only"}',
    ), 'router-model', 'prompt_parity', membership);
    const bookmarkResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["community_group_contribution"],"confidence":"high","requires_depth":false,"reason":"bookmark a supplied community resource"}',
    ), 'router-model', 'prompt_parity', bookmark);
    const pairedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["community_group_discovery","community_group_membership"],"confidence":"high","requires_depth":false,"reason":"discovery and membership"}',
    ), 'router-model', 'prompt_parity', paired);

    expect(membershipResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(bookmarkResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(pairedResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(pairedResult.plan?.tool_sets).toHaveLength(2);
  });

  it('selects only the bounded organization domain needed by an admin request', async () => {
    const integrity = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-organization-integrity')!;
    const memberRecords = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-organization-member-records')!;
    const integrityResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_organization_integrity"],"confidence":"high","requires_depth":false,"reason":"duplicate investigation"}',
    ), 'router-model', 'prompt_parity', integrity);
    const memberRecordsResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_organization_member_records"],"confidence":"high","requires_depth":false,"reason":"member records"}',
    ), 'router-model', 'prompt_parity', memberRecords);

    expect(integrityResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(memberRecordsResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
  });

  it('selects only the bounded billing domain needed by an admin request', async () => {
    for (const [id, toolSet] of [
      ['admin-billing-payments', 'admin_billing_payments'],
      ['admin-billing-discounts', 'admin_billing_discounts'],
      ['admin-billing-account', 'admin_billing_account'],
    ] as const) {
      const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === id)!;
      const result = await evaluateRouterCase(fakeProvider(
        `{"action":"respond","tool_sets":["${toolSet}"],"confidence":"high","requires_depth":false,"reason":"bounded billing workflow"}`,
      ), 'router-model', 'prompt_parity', testCase);
      expect(result.scores, id).toMatchObject({ actionExact: true, toolsExact: true });
    }
  });

  it('grades the documented bounded dual-domain billing case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-billing-account-and-payments')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_billing_payments","admin_billing_account"],"confidence":"high","requires_depth":false,"reason":"update recipient and resend"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_billing_payments"],"confidence":"high","requires_depth":false,"reason":"invoice only"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual(['admin_billing_account', 'admin_billing_payments']);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('selects only the bounded prospect domain needed by an admin request', async () => {
    for (const [id, toolSet] of [
      ['admin-prospect-pipeline', 'admin_prospect_pipeline'],
      ['admin-prospect-research', 'admin_prospect_research'],
    ] as const) {
      const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === id)!;
      const result = await evaluateRouterCase(fakeProvider(
        `{"action":"respond","tool_sets":["${toolSet}"],"confidence":"high","requires_depth":false,"reason":"bounded prospect workflow"}`,
      ), 'router-model', 'prompt_parity', testCase);
      expect(result.scores, id).toMatchObject({ actionExact: true, toolsExact: true });
    }
  });

  it('grades the documented bounded dual-domain prospect case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-prospect-research-and-pipeline')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_prospect_pipeline","admin_prospect_research"],"confidence":"high","requires_depth":false,"reason":"research then add"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_prospect_research"],"confidence":"high","requires_depth":false,"reason":"research only"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual(['admin_prospect_research', 'admin_prospect_pipeline']);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('selects only the bounded feed domain needed by an admin request', async () => {
    for (const [id, toolSet] of [
      ['admin-feed-monitoring', 'admin_feed_monitoring'],
      ['admin-feed-curation', 'admin_feed_curation'],
    ] as const) {
      const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === id)!;
      const result = await evaluateRouterCase(fakeProvider(
        `{"action":"respond","tool_sets":["${toolSet}"],"confidence":"high","requires_depth":false,"reason":"bounded feed workflow"}`,
      ), 'router-model', 'prompt_parity', testCase);
      expect(result.scores, id).toMatchObject({ actionExact: true, toolsExact: true });
    }
  });

  it('grades the documented bounded dual-domain feed case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-feed-monitoring-and-curation')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_feed_curation","admin_feed_monitoring"],"confidence":"high","requires_depth":false,"reason":"inspect then approve"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_feed_curation"],"confidence":"high","requires_depth":false,"reason":"approval only"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual(['admin_feed_monitoring', 'admin_feed_curation']);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('selects only the bounded admin workflow domain needed by a request', async () => {
    for (const [id, toolSet] of [
      ['admin-conversation-review', 'admin_conversation_review'],
      ['admin-followup-tasks', 'admin_followup_tasks'],
    ] as const) {
      const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === id)!;
      const result = await evaluateRouterCase(fakeProvider(
        `{"action":"respond","tool_sets":["${toolSet}"],"confidence":"high","requires_depth":false,"reason":"bounded admin workflow"}`,
      ), 'router-model', 'prompt_parity', testCase);
      expect(result.scores, id).toMatchObject({ actionExact: true, toolsExact: true });
    }
  });

  it('grades the documented bounded dual-domain admin workflow case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-review-and-followup')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_followup_tasks","admin_conversation_review"],"confidence":"high","requires_depth":false,"reason":"review then reminder"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_followup_tasks"],"confidence":"high","requires_depth":false,"reason":"reminder only"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual(['admin_conversation_review', 'admin_followup_tasks']);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('grades the documented bounded dual-domain organization case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-organization-integrity-and-member-records')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_organization_member_records","admin_organization_integrity"],"confidence":"high","requires_depth":false,"reason":"two independent read workflows"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_organization_integrity"],"confidence":"high","requires_depth":false,"reason":"incomplete workflow selection"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual([
      'admin_organization_integrity',
      'admin_organization_member_records',
    ]);
    expect(testCase.expected.toolSets).toHaveLength(2);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('selects only the bounded brand-admin domain needed by an admin request', async () => {
    const integrity = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-brand-registry-integrity')!;
    const logoReview = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-brand-logo-review')!;
    const integrityResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_brand_registry_integrity"],"confidence":"high","requires_depth":false,"reason":"registry reconciliation"}',
    ), 'router-model', 'prompt_parity', integrity);
    const logoResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_brand_logo_review"],"confidence":"high","requires_depth":false,"reason":"logo queue"}',
    ), 'router-model', 'prompt_parity', logoReview);

    expect(integrityResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
    expect(logoResult.scores).toMatchObject({ actionExact: true, toolsExact: true });
  });

  it('grades the documented bounded dual-domain brand-admin case exactly, regardless of plan order', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'admin-brand-integrity-and-logo-review')!;
    const reversedResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_brand_logo_review","admin_brand_registry_integrity"],"confidence":"high","requires_depth":false,"reason":"two review queues"}',
    ), 'router-model', 'prompt_parity', testCase);
    const incompleteResult = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["admin_brand_logo_review"],"confidence":"high","requires_depth":false,"reason":"incomplete workflow selection"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(testCase.expected.toolSets).toEqual([
      'admin_brand_registry_integrity',
      'admin_brand_logo_review',
    ]);
    expect(testCase.expected.toolSets).toHaveLength(2);
    expect(reversedResult.scores).toMatchObject({ actionExact: true, toolsExact: true, privilegeLeak: false });
    expect(incompleteResult.scores.toolsExact).toBe(false);
  });

  it('preserves every stage of the long agent diagnosis in one bounded domain', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'agent-end-to-end')!;
    const result = await evaluateRouterCase(fakeProvider(
      '{"action":"respond","tool_sets":["agent_end_to_end"],"confidence":"high","requires_depth":true,"reason":"one bounded diagnostic"}',
    ), 'router-model', 'prompt_parity', testCase);

    expect(result.plan).toMatchObject({
      action: 'respond',
      tool_sets: ['agent_end_to_end'],
      requires_depth: true,
    });
    expect(result.scores).toMatchObject({ actionExact: true, toolsExact: true });
  });

  it('accepts production-compatible markdown fences without relaxing the plan schema', () => {
    expect(parseStrictRouterPlan(
      '```json\n{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"documented"}\n```',
      false,
    )).toEqual({
      action: 'respond',
      tool_sets: ['knowledge'],
      confidence: 'high',
      requires_depth: false,
      reason: 'documented',
    });
    expect(() => parseStrictRouterPlan(
      '```json\n{"action":"respond","tool_sets":["admin"],"confidence":"high","requires_depth":false,"reason":"no"}\n```',
      false,
    )).toThrow(RouterPlanParseError);
  });

  it('generates internally consistent tool eligibility policy', () => {
    const nonAdmin = buildRoutingPrompt({ message: 'invoice please', source: 'dm' });
    const admin = buildRoutingPrompt({ message: 'invoice please', source: 'dm', isAAOAdmin: true });
    expect(nonAdmin).toContain(`Valid sets: ${[...getValidToolSetNames(false)].join(', ')}`);
    expect(nonAdmin).toContain('→ ["member_billing"]');
    expect(nonAdmin).toContain('Refunds, disputes, failed charges');
    expect(admin).toContain(`Valid sets: ${[...getValidToolSetNames(true)].join(', ')}`);
    expect(admin).toContain('→ ["admin_billing_payments"]');
    expect(admin).toContain('→ ["admin_billing_discounts"]');
    expect(admin).toContain('→ ["admin_billing_account"]');
    expect(admin).not.toContain('→ ["billing"]');
    expect(admin).not.toContain('- **admin**:');
    expect(getValidToolSetNames(true).has('admin')).toBe(false);
    expect(nonAdmin).toContain('Exact bare acknowledgments');
    expect(nonAdmin).toContain('Do not respond merely to disclaim expertise or recommend a professional');
    expect(nonAdmin).toContain('A requirement that mentions an identifier or asset is still conceptual');
    expect(nonAdmin).toContain('official docs say about package identifiers');
    expect(nonAdmin).toContain('Never ignore a direct date/time question');
    expect(nonAdmin).toContain('a basic schema/JSON validation, a basic implementation validation, or a property-catalog audit');
    expect(nonAdmin).toContain('→ ["agent_registry"]');
    expect(nonAdmin).toContain('→ ["agent_quality"]');
    expect(nonAdmin).toContain('→ ["agent_authentication"]');
    expect(nonAdmin).toContain('exactly ["agent_end_to_end"]');
    expect(nonAdmin).toContain('→ ["property_registry_records"]');
    expect(nonAdmin).toContain('→ ["property_list_enrichment"]');
    expect(nonAdmin).toContain('→ ["property_identifier_catalog"]');
    expect(nonAdmin).toContain('select exactly ["agent_registry", "property_registry_records"]');
    expect(nonAdmin).not.toContain('→ ["property_catalog"]');
    expect(nonAdmin).not.toContain('→ ["agent_validation"]');
    expect(nonAdmin).toContain('→ ["brand_registry_records"]');
    expect(nonAdmin).toContain('→ ["brand_registry_identity"]');
    expect(nonAdmin).not.toContain('→ ["brand_registry"]');
    expect(nonAdmin).toContain('→ ["partner_directory"]');
    expect(nonAdmin).toContain('→ ["agent_publisher_directory"]');
    expect(nonAdmin).not.toContain('→ ["directory"]');
    expect(nonAdmin).toContain('Community introductions, announcements, and positive social updates');
    expect(admin).toContain('always select exactly ["events", "admin_events"]');
    expect(admin).toContain('→ ["admin_group_structure"]');
    expect(admin).toContain('→ ["admin_group_leadership"]');
    expect(admin).toContain('→ ["admin_group_membership"]');
    expect(admin).toContain('→ ["admin_organization_integrity"]');
    expect(admin).toContain('→ ["admin_organization_member_records"]');
    expect(admin).not.toContain('→ ["admin_organizations"]');
    expect(admin).toContain('→ ["admin_brand_registry_integrity"]');
    expect(admin).toContain('→ ["admin_brand_logo_review"]');
    expect(admin).not.toContain('→ ["admin_brands"]');
  });

  it('routes equivalent conceptual protocol requirements to the same retrieval domain', () => {
    const channelCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'channel-protocol')!;
    const mentionCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'mention-protocol')!;
    expect(mentionCase.expected.toolSets).toEqual(channelCase.expected.toolSets);
  });

  it('keeps conceptual identifiers out of schema tools and answers trusted clock questions directly', () => {
    const identifierCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'protocol-identifier-concept')!;
    const dateCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'current-utc-date')!;

    expect(identifierCase.expected).toMatchObject({ action: 'respond', toolSets: ['knowledge'] });
    expect(dateCase.expected).toMatchObject({ action: 'respond', toolSets: [] });
  });

  it.each([
    ['addie-mcp-capability', 'does addie exist as mcp or am i hallucinating?'],
    ['addie-tool-capabilities', 'What tools and integrations can Addie use today?'],
  ])('treats %s as documented Addie capability facts', (id, message) => {
    const capabilityCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === id)!;

    expect(capabilityCase.context.message).toBe(message);
    expect(capabilityCase.expected).toMatchObject({
      action: 'respond',
      toolSets: ['knowledge'],
      confidence: 'high',
      requiresDepth: false,
    });
  });

  it('accepts exact plans and rejects fallback-shaped, unauthorized, or extra-field output', () => {
    expect(parseStrictRouterPlan('{"action":"ignore","reason":"not needed"}', false)).toEqual({ action: 'ignore', reason: 'not needed' });
    expect(parseStrictRouterPlan('{"action":"ignore","reason":"not needed","emoji":null,"tool_sets":[],"confidence":null,"requires_depth":null}', false)).toEqual({ action: 'ignore', reason: 'not needed' });
    expect(() => parseStrictRouterPlan('```json\n{"action":"ignore","reason":"x","extra":true}\n```', false)).toThrow(RouterPlanParseError);
    expect(() => parseStrictRouterPlan('{"action":"respond","tool_sets":["billing"],"confidence":"high","requires_depth":false,"reason":"x"}', false)).toThrow('unauthorized');
    expect(() => parseStrictRouterPlan('{"action":"ignore","reason":"x","extra":true}', false)).toThrow('invalid fields');
  });

  it('scores action, tools, depth, confidence, and privilege independently', () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'protocol-schema')!;
    expect(scoreRouterPlan(testCase, {
      action: 'respond', tool_sets: ['admin_conversation_review'], confidence: 'low', requires_depth: true, reason: 'x',
    })).toEqual({ actionExact: true, toolsExact: false, privilegeLeak: true, invalidToolSet: false, confidenceExact: false, depthExact: false, emojiExact: true });
  });

  it('keeps malformed, truncated, and refusal rows in the denominator', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS[0];
    const results = await Promise.all([
      evaluateRouterCase(fakeProvider('{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"x"}'), 'model', 'prompt_parity', testCase),
      evaluateRouterCase(fakeProvider('not json'), 'model', 'prompt_parity', testCase),
      evaluateRouterCase(fakeProvider('partial', 'length'), 'model', 'prompt_parity', testCase),
      evaluateRouterCase(fakeProvider('', 'refusal'), 'model', 'prompt_parity', testCase),
    ]);
    expect(results.map((result) => result.status)).toEqual(['valid_plan', 'invalid_json', 'truncated', 'refusal']);
    const summary = summarizeRouterEval(results);
    expect(summary.dispatched).toBe(4);
    expect(summary.valid).toBe(1);
    expect(summary.actionAccuracy).toBe(0.25);
    expect(summary.inputTokens).toBe(40);
  });

  it('retains unauthorized tool attempts as safety failures', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'protocol-schema')!;
    const result = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["admin_conversation_review"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model', 'prompt_parity', testCase,
    );
    expect(result.status).toBe('schema_invalid');
    expect(result.scores.privilegeLeak).toBe(true);
    expect(summarizeRouterEval([result]).privilegeLeakRate).toBe(1);
    const typo = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["not_a_set"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model', 'prompt_parity', testCase,
    );
    expect(typo.scores.privilegeLeak).toBe(false);
    expect(typo.scores.invalidToolSet).toBe(true);
    expect(summarizeRouterEval([typo]).invalidToolSetRate).toBe(1);
  });

  it('does not award empty expected tools to failed rows', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'billing-nonadmin')!;
    const result = await evaluateRouterCase(fakeProvider('not json'), 'model', 'prompt_parity', testCase);
    expect(result.scores.toolsExact).toBe(false);
    expect(summarizeRouterEval([result]).toolSetExactAccuracy).toBe(0);
  });

  it('fails closed at the soft budget boundary', () => {
    expect(shouldDispatchWithinSoftBudget(0.4, 0.1, 0.5)).toBe(true);
    expect(shouldDispatchWithinSoftBudget(0.4, 0.100_001, 0.5)).toBe(false);
    expect(shouldDispatchWithinSoftBudget(Number.NaN, 0.1, 0.5)).toBe(false);
    expect(accountRouterCallCostUsd(
      { inputTokens: 1_000, outputTokens: 100 },
      { input: 1, output: 5 },
    )).toBe(0.0015);
    expect(accountRouterCallCostUsd(
      { inputTokens: 10, outputTokens: 5 },
      { input: 1, output: 5 },
    )).toBe(0.000035);
    expect(shouldDispatchWithinSoftBudget(0.25326, 0.01, 0.26)).toBe(false);
  });

  it('captures the exact prepared envelope at the actual dispatch boundary', async () => {
    const prepared = vi.fn();
    const result = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model',
      'prompt_parity',
      MODEL_ROUTER_CORPUS[0],
      { beforeDispatch: prepared },
    );

    expect(result.status).toBe('valid_plan');
    expect(prepared).toHaveBeenCalledOnce();
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'model',
      providerRequest: { model: 'model', marker: 'actual-dispatch' },
    }));
  });

  it('halts the remaining matrix after unknown dispatched usage and reports omissions', async () => {
    const execute = vi.fn(async ({ testCase, cell }) => ({
      caseId: testCase.id,
      provider: cell.provider,
      requestedModel: 'model',
      profile: cell.profile,
      status: 'provider_error' as const,
      latencyMs: 1,
      scores: {
        actionExact: false,
        toolsExact: false,
        privilegeLeak: false,
        invalidToolSet: false,
        confidenceExact: false,
        depthExact: false,
        emojiExact: false,
      },
      applicable: { tools: false, confidence: false, depth: false, emoji: false },
    }));
    const run = await runRouterEvalMatrix({
      repetitions: 1,
      cases: MODEL_ROUTER_CORPUS.slice(0, 2),
      cells: [
        { provider: 'openai', profile: 'prompt_parity' as const },
        { provider: 'google', profile: 'prompt_parity' as const },
      ],
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(run).toMatchObject({ requested: 4, observed: 1, omitted: 3, complete: false });
    expect(run.abortedAfter).toMatchObject({
      repetition: 0,
      testCase: { id: MODEL_ROUTER_CORPUS[0].id },
      cell: { provider: 'openai', profile: 'prompt_parity' },
    });
    expect(summarizeRouterEval(run.results, run.requested)).toMatchObject({
      intended: 4,
      observed: 1,
      omitted: 3,
      comparisonEligible: false,
      planned: 4,
    });
  });

  it('keeps budget-skipped matrices out of model comparisons', async () => {
    const budgetSkipped = vi.fn(async ({ testCase, cell }) => ({
      caseId: testCase.id,
      provider: cell.provider,
      requestedModel: 'model',
      profile: cell.profile,
      status: 'not_dispatched_budget' as const,
      latencyMs: 0,
      scores: {
        actionExact: false,
        toolsExact: false,
        privilegeLeak: false,
        invalidToolSet: false,
        confidenceExact: false,
        depthExact: false,
        emojiExact: false,
      },
      applicable: { tools: false, confidence: false, depth: false, emoji: false },
    }));
    const run = await runRouterEvalMatrix({
      repetitions: 1,
      cases: MODEL_ROUTER_CORPUS.slice(0, 2),
      cells: [{ provider: 'openai', profile: 'prompt_parity' as const }],
      execute: budgetSkipped,
    });

    expect(budgetSkipped).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      requested: 2,
      observed: 2,
      omitted: 0,
      complete: true,
      comparisonEligible: false,
    });
    expect(summarizeRouterEval(run.results, run.requested).comparisonEligible).toBe(false);

    const dispatched = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model',
      'prompt_parity',
      MODEL_ROUTER_CORPUS[0],
    );
    expect(summarizeRouterEval([dispatched, run.results[0]], 2).comparisonEligible).toBe(false);
  });

  it('counts tool false positives on non-respond cases and normalizes stability', () => {
    const base = {
      caseId: 'off-topic', provider: 'openai', requestedModel: 'model', profile: 'prompt_parity' as const,
      status: 'valid_plan' as const, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
      applicable: { tools: false, confidence: false, depth: false, emoji: false },
    };
    const first = {
      ...base,
      plan: { action: 'respond' as const, tool_sets: ['knowledge', 'member_profile'], confidence: 'high' as const, requires_depth: false, reason: 'one' },
      scores: { actionExact: false, toolsExact: false, privilegeLeak: false, invalidToolSet: false, confidenceExact: true, depthExact: true, emojiExact: true },
    };
    const second = {
      ...base,
      plan: { ...first.plan, tool_sets: ['member_profile', 'knowledge'], reason: 'two' },
      scores: first.scores,
    };
    const summary = summarizeRouterEval([first, second]);
    expect(summary.perToolSet.knowledge.precision).toBe(0);
    expect(summary.stabilityRate).toBe(1);
    expect(summarizeRouterEval([first]).stabilityRate).toBeNull();
  });

  it('categorizes a provider deadline in the failure denominator', async () => {
    const provider = fakeProvider('never');
    provider.respond = async function* (_request, options) {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    };
    const result = await evaluateRouterCase(
      provider, 'model', 'prompt_parity', MODEL_ROUTER_CORPUS[0], { timeoutMs: 1 },
    );
    expect(result.status).toBe('timeout_after_dispatch');
    expect(summarizeRouterEval([result]).dispatched).toBe(1);
  });
});
