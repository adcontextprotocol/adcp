import { describe, it, expect, beforeEach } from 'vitest';
import { loadRules, loadResponseStyle, invalidateRulesCache } from '../../src/addie/rules/index.js';
import {
  ADDIE_TOOL_REFERENCE,
  buildAddieScopedToolReference,
  buildAddieStableToolReference,
  buildAddieToolReference,
} from '../../src/addie/prompts.js';
import { getToolsForSets } from '../../src/addie/tool-sets.js';

describe('Rules Loader', () => {
  beforeEach(() => {
    invalidateRulesCache();
  });

  it('loadRules() loads the four base rule sections (response-style is loaded separately)', () => {
    const rules = loadRules();

    expect(rules).toContain('# Core Identity');
    expect(rules).toContain('# Behaviors');
    expect(rules).toContain('# Knowledge');
    expect(rules).toContain('# Constraints');
    // response-style.md is loaded by loadResponseStyle() and appended
    // after the tool reference at assembly time — see claude-client.ts.
    expect(rules).not.toContain('# Response Style');
  });

  it('loadResponseStyle() returns the response-style.md content', () => {
    const style = loadResponseStyle();
    expect(style).toContain('# Response Style');
    expect(style).toContain('## Concise and Helpful');
    expect(style).toContain('## Naming Conventions');
  });

  it('should join sections with --- separators', () => {
    const rules = loadRules();
    const sections = rules.split('\n\n---\n\n');

    // Four hardcoded base rule files (identity, behaviors, knowledge, urls,
    // constraints) + any injected sections (current-context, expert-panel)
    // loaded from .agents/ and .claude/agents/. Only the minimum-four
    // contract is load-bearing here.
    expect(sections.length).toBeGreaterThanOrEqual(4);
  });

  it('should include key rules from each base section', () => {
    const rules = loadRules();

    // Identity (now consolidates voice / character traits previously
    // spread across constraints — Honesty, Welcoming people in, etc.)
    expect(rules).toContain('## Core Mission');
    expect(rules).toContain('### Certification identity handoff');
    expect(rules).toContain('Stay Sage while that context is present');
    expect(rules).toContain('## Sage certification resume');
    expect(rules).toContain('## Welcoming people in');
    expect(rules).toContain('## Honesty over confidence');

    // Behaviors
    expect(rules).toContain('## Verify Claims With Tools');
    expect(rules).toContain('## Partner Directory');

    // Knowledge
    expect(rules).toContain('## Prebid Expertise');
    expect(rules).toContain('## Trusted Match Protocol (TMP)');

    // Constraints (deterministic guardrails only after the voice migration)
    expect(rules).toContain('## Tool Outcomes — Three Distinct Cases');
    expect(rules).toContain('## Domain Focus - CRITICAL');
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

  it('routes Prebid Sales Agent build questions to the owning project without guessing', () => {
    const rules = loadRules();

    expect(rules).toContain('Prebid.org maintains the Prebid Sales Agent');
    expect(rules).toContain('repo_id "salesagent"');
    expect(rules).toContain('https://prebid.org/product-suite/sales-agent/');
    expect(rules).toContain('support@prebid.org');
    expect(rules).toContain('Do not invent package files, repository names, versions, or upgrade steps');
    expect(rules).toContain('do not route these questions to AgenticAdvertising.org Slack');
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

  it('scopes admin guidance and the authoritative catalog to routed domains', () => {
    const reference = buildAddieToolReference({
      availableToolNames: getToolsForSets(['admin_prospects'], true, false),
      selectedToolSetNames: ['admin_prospects'],
    });

    expect(reference).toContain('### Admin prospect operations');
    expect(reference).toContain('- **admin_prospects** *(admin only)*');
    expect(reference).toContain('query_prospects');
    expect(reference).not.toContain('### Admin organization operations');
    expect(reference).not.toContain('- **admin_organizations**');
    expect(reference).not.toContain('merge_organizations');
    expect(reference).not.toContain('### Admin workflow operations');
  });

  it('keeps the cacheable guidance stable while domain instructions vary', () => {
    const stable = buildAddieStableToolReference();
    const scoped = buildAddieScopedToolReference({
      availableToolNames: getToolsForSets(['admin_workflows'], true, false),
      selectedToolSetNames: ['admin_workflows'],
    });

    expect(stable).toContain('## Behavioral Guidelines');
    expect(stable).not.toContain('### Admin workflow operations');
    expect(stable).not.toContain('## Authoritative custom-tool catalog');
    expect(scoped).toContain('### Admin workflow operations');
    expect(scoped).toContain('- **admin_workflows** *(admin only)*');
  });

  it('loads knowledge guidance only for the routed knowledge domain', () => {
    const knowledge = buildAddieToolReference({
      availableToolNames: getToolsForSets(['knowledge'], false, false),
      selectedToolSetNames: ['knowledge'],
    });
    const directory = buildAddieToolReference({
      availableToolNames: getToolsForSets(['directory'], false, false),
      selectedToolSetNames: ['directory'],
    });

    expect(knowledge).toContain('### Knowledge search operations');
    expect(knowledge).not.toContain('### Member-directory operations');
    expect(directory).toContain('### Member-directory operations');
    expect(directory).not.toContain('### Knowledge search operations');
  });

  it('scopes community and content guidance to their selected sets', () => {
    const member = buildAddieToolReference({
      availableToolNames: getToolsForSets(['member'], false, false),
      selectedToolSetNames: ['member'],
    });
    const meetings = buildAddieToolReference({
      availableToolNames: getToolsForSets(['meetings'], false, false),
      selectedToolSetNames: ['meetings'],
    });

    expect(member).toContain('### Working-group operations');
    expect(member).toContain('### Member profile and company-listing operations');
    expect(member).toContain('### Member content operations');
    expect(member).not.toContain('### Meeting operations');
    expect(meetings).toContain('### Meeting operations');
    expect(meetings).not.toContain('### Member profile and company-listing operations');
  });

  it('scopes account self-service guidance to member requests', () => {
    const member = buildAddieToolReference({
      availableToolNames: getToolsForSets(['member'], false, false),
      selectedToolSetNames: ['member'],
    });
    const knowledge = buildAddieToolReference({
      availableToolNames: getToolsForSets(['knowledge'], false, false),
      selectedToolSetNames: ['knowledge'],
    });

    expect(member).toContain('### Member account and organization self-service');
    expect(member).toContain('https://agenticadvertising.org/onboarding');
    expect(knowledge).not.toContain('### Member account and organization self-service');
  });

  it('scopes complete member billing guidance to the routed billing surface', () => {
    const billing = buildAddieToolReference({
      availableToolNames: getToolsForSets(['member_billing'], false, false),
      selectedToolSetNames: ['member_billing'],
    });
    const knowledge = buildAddieToolReference({
      availableToolNames: getToolsForSets(['knowledge'], false, false),
      selectedToolSetNames: ['knowledge'],
    });

    expect(billing).toContain('### Member billing self-service');
    expect(billing).toContain('confirm_send_invoice');
    expect(billing).toContain('- **member_billing**');
    expect(knowledge).not.toContain('### Member billing self-service');
    expect(buildAddieStableToolReference()).not.toContain('**Billing Support (for members):**');
  });

  it('scopes roadmap and file-handling guidance to knowledge requests', () => {
    const knowledge = buildAddieToolReference({
      availableToolNames: getToolsForSets(['knowledge'], false, false),
      selectedToolSetNames: ['knowledge'],
    });
    const events = buildAddieToolReference({
      availableToolNames: getToolsForSets(['events'], false, false),
      selectedToolSetNames: ['events'],
    });

    expect(knowledge).toContain('### GitHub roadmap research');
    expect(knowledge).toContain('### Slack file handling');
    expect(events).not.toContain('### GitHub roadmap research');
    expect(events).not.toContain('### Slack file handling');
  });

  it('scopes protocol and agent-testing guidance to their routed domains', () => {
    const protocol = buildAddieToolReference({
      availableToolNames: getToolsForSets(['adcp_operations'], false, false),
      selectedToolSetNames: ['adcp_operations'],
    });
    const testing = buildAddieToolReference({
      availableToolNames: getToolsForSets(['agent_testing'], false, false),
      selectedToolSetNames: ['agent_testing'],
    });

    expect(protocol).toContain('### AdCP protocol operations');
    expect(protocol).toContain('### Seller-agent monitoring');
    expect(protocol).toContain('### Building with AdCP');
    expect(protocol).not.toContain('### Publisher and agent testing');
    expect(protocol).not.toContain('### Property-registry operations');
    expect(testing).toContain('### Publisher and agent testing');
    expect(testing).toContain('### Property-registry operations');
    expect(testing).toContain('### Building with AdCP');
    expect(testing).not.toContain('### AdCP protocol operations');
    expect(testing).not.toContain('### Seller-agent monitoring');
  });

  it('scopes brand guidance to directory requests', () => {
    const directory = buildAddieToolReference({
      availableToolNames: getToolsForSets(['directory'], false, false),
      selectedToolSetNames: ['directory'],
    });
    const testing = buildAddieToolReference({
      availableToolNames: getToolsForSets(['agent_testing'], false, false),
      selectedToolSetNames: ['agent_testing'],
    });

    expect(directory).toContain('### Brand-registry operations');
    expect(directory).not.toContain('### Property-registry operations');
    expect(testing).not.toContain('### Brand-registry operations');
  });

  it('requires optional storyboard tools before advertising that workflow', () => {
    const routedTools = getToolsForSets(['agent_testing'], false, false);
    const withoutConditionalTools = buildAddieToolReference({
      availableToolNames: routedTools,
      selectedToolSetNames: ['agent_testing'],
    });
    const withPartialStoryboardTools = buildAddieToolReference({
      availableToolNames: [...routedTools, 'recommend_storyboards'],
      selectedToolSetNames: ['agent_testing'],
    });
    const withConditionalTools = buildAddieToolReference({
      availableToolNames: [
        ...routedTools,
        'recommend_storyboards',
        'get_storyboard_detail',
        'run_storyboard',
        'run_storyboard_step',
        'get_adcp_capabilities',
      ],
      selectedToolSetNames: ['agent_testing'],
    });

    expect(withoutConditionalTools).not.toContain('### Storyboard testing');
    expect(withoutConditionalTools).toContain('### Property-list enrichment');
    expect(withPartialStoryboardTools).not.toContain('### Storyboard testing');
    expect(withConditionalTools).toContain('### Storyboard testing');
    expect(withConditionalTools).toContain('### Property-list enrichment');
  });

  it('requires exact knowledge tools before advertising conditional guidance', () => {
    const knowledgeTools = getToolsForSets(['knowledge'], false, false);
    const withoutSlackFile = buildAddieToolReference({
      availableToolNames: knowledgeTools.filter(name => name !== 'read_slack_file'),
      selectedToolSetNames: ['knowledge'],
    });
    const withoutGithubList = buildAddieToolReference({
      availableToolNames: knowledgeTools.filter(name => name !== 'list_github_issues'),
      selectedToolSetNames: ['knowledge'],
    });

    expect(withoutSlackFile).not.toContain('### Slack file handling');
    expect(withoutGithubList).not.toContain('### GitHub roadmap research');
  });

  it('loads certification safety guidance only with the complete routed workflow', () => {
    const certificationTools = getToolsForSets(['certification'], false, false);
    const certification = buildAddieToolReference({
      availableToolNames: certificationTools,
      selectedToolSetNames: ['certification'],
    });
    const activeSession = buildAddieToolReference({
      availableToolNames: getToolsForSets(['certification', 'knowledge'], false, false),
      selectedToolSetNames: ['certification', 'knowledge'],
    });
    const missingCheckpoint = buildAddieToolReference({
      availableToolNames: certificationTools.filter(name => name !== 'checkpoint_teaching_progress'),
      selectedToolSetNames: ['certification'],
    });
    const knowledge = buildAddieToolReference({
      availableToolNames: getToolsForSets(['knowledge'], false, false),
      selectedToolSetNames: ['knowledge'],
    });

    expect(certification).toContain('## AdCP Academy');
    expect(certification).toContain('MUST call start_certification_module IMMEDIATELY');
    expect(certification).toContain('ALWAYS call checkpoint_teaching_progress');
    expect(certification).toContain('BUILD PROJECT ERROR COACHING');
    expect(activeSession).toContain('## AdCP Academy');
    expect(activeSession).toContain('### Knowledge search operations');
    expect(missingCheckpoint).not.toContain('## AdCP Academy');
    expect(knowledge).not.toContain('## AdCP Academy');
  });

  it('loads Sponsored Intelligence relay guidance only with the complete routed workflow', () => {
    const siTools = getToolsForSets(['sponsored_intelligence'], false, false);
    const sponsoredIntelligence = buildAddieToolReference({
      availableToolNames: siTools,
      selectedToolSetNames: ['sponsored_intelligence'],
    });
    const missingRelay = buildAddieToolReference({
      availableToolNames: siTools.filter(name => name !== 'send_to_si_agent'),
      selectedToolSetNames: ['sponsored_intelligence'],
    });
    const knowledge = buildAddieToolReference({
      availableToolNames: getToolsForSets(['knowledge'], false, false),
      selectedToolSetNames: ['knowledge'],
    });

    expect(sponsoredIntelligence).toContain('### Sponsored Intelligence conversations');
    expect(sponsoredIntelligence).toContain('use send_to_si_agent for every user message');
    expect(missingRelay).not.toContain('### Sponsored Intelligence conversations');
    expect(knowledge).not.toContain('### Sponsored Intelligence conversations');
  });

  it('loads property catalog guidance only with the complete routed workflow', () => {
    const propertyTools = getToolsForSets(['agent_testing'], false, false);
    const complete = buildAddieToolReference({
      availableToolNames: propertyTools,
      selectedToolSetNames: ['agent_testing'],
    });
    const missingDispute = buildAddieToolReference({
      availableToolNames: propertyTools.filter(name => name !== 'dispute_catalog_entry'),
      selectedToolSetNames: ['agent_testing'],
    });

    expect(complete).toContain('### Property-list enrichment');
    expect(complete).toContain('### Property catalog operations');
    expect(missingDispute).not.toContain('### Property catalog operations');
  });

  it('loads brand canonical guidance only with the complete routed workflow', () => {
    const directoryTools = getToolsForSets(['directory'], false, false);
    const complete = buildAddieToolReference({
      availableToolNames: directoryTools,
      selectedToolSetNames: ['directory'],
    });
    const missingCheck = buildAddieToolReference({
      availableToolNames: directoryTools.filter(name => name !== 'check_mutual_assertion'),
      selectedToolSetNames: ['directory'],
    });

    expect(complete).toContain('### Brand canonical-document operations');
    expect(complete).toContain('upload_brand_logo');
    expect(missingCheck).not.toContain('### Brand canonical-document operations');
  });

  it('keeps migrated protocol-domain prose out of the stable prompt', () => {
    const stable = buildAddieStableToolReference();

    expect(stable).not.toContain('### Publisher and agent testing');
    expect(stable).not.toContain('### AdCP protocol operations');
    expect(stable).not.toContain('### Seller-agent monitoring');
    expect(stable).not.toContain('### Brand-registry operations');
    expect(stable).not.toContain('### Property-registry operations');
    expect(stable).not.toContain('### Building with AdCP');
    expect(stable).not.toContain('### Member account and organization self-service');
    expect(stable).not.toContain('### GitHub roadmap research');
    expect(stable).not.toContain('### Slack file handling');
    expect(stable).not.toContain('## AdCP Academy');
    expect(stable).not.toContain('MUST call start_certification_module IMMEDIATELY');
    expect(stable).not.toContain('### Sponsored Intelligence conversations');
    expect(stable).not.toContain('send_to_si_agent for EVERY user message');
  });

  it('does not advertise neighboring domain mutations in scoped guidance', () => {
    const member = buildAddieToolReference({
      availableToolNames: getToolsForSets(['member'], false, false),
      selectedToolSetNames: ['member'],
    });
    const events = buildAddieToolReference({
      availableToolNames: getToolsForSets(['events'], false, false),
      selectedToolSetNames: ['events'],
    });
    const content = buildAddieToolReference({
      availableToolNames: getToolsForSets(['content'], false, false),
      selectedToolSetNames: ['content'],
    });

    expect(member).not.toContain('add_committee_document:');
    expect(member).not.toContain('get_member_engagement:');
    expect(events).not.toContain('create_event:');
    expect(events).not.toContain('manage_event_registrations:');
    expect(content).not.toContain('attach_content_asset:');
    expect(content).toContain('### Editorial content operations');
  });

  it('omits selected-domain guidance when no domain tool reached the wire', () => {
    const scoped = buildAddieScopedToolReference({
      availableToolNames: ['search_docs'],
      selectedToolSetNames: ['admin_workflows'],
    });

    expect(scoped).not.toContain('### Admin workflow operations');
    expect(scoped).not.toContain('- **admin_workflows**');
  });

  it('lists only tool names present on the request wire surface', () => {
    const reference = buildAddieToolReference({
      availableToolNames: ['search_docs', 'get_doc', 'not_a_registered_tool'],
      selectedToolSetNames: ['knowledge'],
    });
    const catalog = reference.slice(reference.indexOf('## Authoritative custom-tool catalog (request-scoped)'));

    expect(catalog).toContain('- **knowledge** — search_docs, get_doc');
    expect(catalog).not.toContain('search_repos');
    expect(catalog).not.toContain('not_a_registered_tool');
    expect(catalog).not.toContain('- **admin_prospects**');
  });

  it('response-style.md lands at the END of the assembled system prompt', () => {
    // Mirror the production ordering — base rules, tool reference, then
    // response-style.md. Style instructions need to
    // be the LAST section the model reads. The prior ordering (style
    // before tool reference) was contradicted by the rules/index.ts
    // comment claiming style was last; the prompt-variant eval confirmed
    // moving style to truly-last cuts shape violations on Sonnet 4.6.
    const assembled = `${loadRules()}\n\n---\n\n${ADDIE_TOOL_REFERENCE}\n\n---\n\n${loadResponseStyle()}`;
    const styleIdx = assembled.indexOf('# Response Style');
    const catalogIdx = assembled.indexOf('## Authoritative tool catalog (auto-generated)');
    expect(catalogIdx).toBeGreaterThan(0);
    expect(styleIdx).toBeGreaterThan(catalogIdx);
  });

  it('includes the honest-search-report rule', () => {
    const rules = loadRules();
    expect(rules).toContain('## Honest Reporting After Search');
    expect(rules).toContain("aren't loaded in this conversation");
  });

  it('uses a valid human-action escalation category for failed Slack invites', () => {
    const rules = loadRules();
    const slackRules = rules.slice(
      rules.indexOf('## Slack Invite Domain Restrictions'),
      rules.indexOf('## Email Verification and Notification Failures')
    );
    expect(slackRules).toContain('category `needs_human_action`');
    expect(slackRules).not.toContain("'invite' category");
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
