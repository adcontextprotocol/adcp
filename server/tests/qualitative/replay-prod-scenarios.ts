/**
 * Qualitative replay of real production scenarios.
 *
 * Routes messages through the router, then generates actual Claude responses
 * with the confidence calibration prompt — so we can see what Addie would
 * actually SAY, not just how she routes.
 *
 * Run: npx tsx server/tests/qualitative/replay-prod-scenarios.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { AddieRouter } from '../../src/addie/router.js';
import type { RoutingContext, ConfidenceTier } from '../../src/addie/router.js';
import {
  gradeRfcRun,
  RFC_STUB_TOOLS,
  stubToolResult,
  type RfcExpectations,
  type RfcRunObservations,
} from '../../src/addie/testing/rfc-grader.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const adminApiKey = process.env.ADMIN_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

const router = new AddieRouter(apiKey);
const client = new Anthropic({ apiKey });

// Fetch Addie's system prompt — by default from deployed prod, but
// RFC_USE_LOCAL_PROMPT=1 builds it from server/src/addie/rules/ so rule
// edits can be validated before deployment.
let realSystemPrompt: string | null = null;
async function getSystemPrompt(): Promise<string> {
  if (realSystemPrompt) return realSystemPrompt;

  if (process.env.RFC_USE_LOCAL_PROMPT === '1') {
    const { loadRules, loadResponseStyle } = await import('../../src/addie/rules/index.js');
    const { ADDIE_TOOL_REFERENCE } = await import('../../src/addie/prompts.js');
    realSystemPrompt = `${loadRules()}\n\n---\n\n${ADDIE_TOOL_REFERENCE}\n\n---\n\n${loadResponseStyle()}`;
    console.log(`Built local system prompt from rules/ (${realSystemPrompt.length} chars)`);
    return realSystemPrompt;
  }

  if (adminApiKey) {
    try {
      const res = await fetch('https://agenticadvertising.org/api/admin/addie/system-prompt', {
        headers: { Authorization: `Bearer ${adminApiKey}` },
      });
      const data = await res.json() as { system_prompt?: string };
      if (data.system_prompt) {
        realSystemPrompt = data.system_prompt;
        console.log(`Loaded real system prompt from prod (${realSystemPrompt.length} chars)`);
        return realSystemPrompt;
      }
    } catch (e) {
      console.warn('Could not fetch prod system prompt, using minimal fallback');
    }
  }

  // Fallback
  realSystemPrompt = 'You are Addie, the AI assistant for AgenticAdvertising.org (AAO). You help with the Ad Context Protocol (AdCP), membership, certification, and connecting members. Be concise. Match the conversational register of the message.';
  return realSystemPrompt;
}

// Replicate buildConfidenceCalibration from bolt-app.ts
function buildConfidenceCalibration(confidence: ConfidenceTier): string {
  if (confidence === 'low') {
    return '## Response Calibration\nYou are not confident you can answer this well. Lead with "I\'m not sure about this" and keep it brief (2-3 sentences). Suggest who might help if you know.';
  }
  if (confidence === 'suggest') {
    return '## Response Calibration\nYou cannot answer this directly but know who can. Give a brief pointer (1-2 sentences) to a specific person, working group, or channel. Do not explain what you cannot do.';
  }
  return '';
}

interface Scenario {
  name: string;
  who: string;
  message: string;
  source: 'dm' | 'channel' | 'mention';
  channelName?: string;
  isAdmin?: boolean;
  /** What happened in prod (for comparison) */
  prodBehavior: string;
  /** What we expect now */
  expectedBehavior: string;
  /**
   * Tag for grading mode. 'rfc' scenarios get the multi-turn tool loop and
   * rfc-grader scoring; everything else uses the legacy IGNORE/RESPOND
   * prefix check. Default = legacy behavior.
   */
  category?: 'rfc';
  /** Per-scenario RFC expectations — only consulted when category === 'rfc'. */
  rfc?: RfcExpectations;
}

const scenarios: Scenario[] = [
  // ---- CHANNEL: should be ignored ----
  {
    name: 'Legal question from outside counsel',
    who: 'Noga Rosenthal',
    message: 'Hi- I got asked this question by outside legal counsel: If an AI agent gets an ad impression, does that count as an "impression?" Do we count that in our measurement reports? If not, what happens?',
    source: 'channel',
    channelName: 'general',
    prodBehavior: 'Addie responded with 300-word essay starting with "Honest answer: AdCP doesn\'t directly address this"',
    expectedBehavior: 'IGNORE — legal question, not Addie\'s domain',
  },
  {
    name: 'Meeting scheduling complaint',
    who: 'Joshua Koran',
    message: 'I just noticed our meeting for tomorrow was moved to way too early. Whomever controls this can we move it back to the normal time?',
    source: 'channel',
    channelName: 'general',
    prodBehavior: 'Addie responded with meeting tool suggestions',
    expectedBehavior: 'IGNORE — scheduling is for humans',
  },
  {
    name: 'North Star strategy discussion',
    who: 'Michael Barnaby',
    message: 'Hot of the back of two great London based events with Prebid and AdCP - great work from everyone involved. A slight product based question: what are peoples thoughts on our collective North Star? How do we know we\'re gaining the correct momentum/adoption?',
    source: 'channel',
    channelName: 'general',
    prodBehavior: 'Addie jumped in with opinions about org metrics and North Star candidates',
    expectedBehavior: 'IGNORE — community strategy debate',
  },
  {
    name: 'Message directed at specific person',
    who: 'Pia Malovrh',
    message: '<@U09CABK88NR> could you please help with the above?',
    source: 'channel',
    channelName: 'general',
    prodBehavior: 'Correctly ignored',
    expectedBehavior: 'IGNORE — addressed to @Morgan',
  },

  // ---- CHANNEL: should respond ----
  {
    name: 'Schema enum question in working group',
    who: 'Harvin Gupta',
    message: 'we configuring creative agent for Adzymic formats, whereas category we using apx_impact as format_category identification for schemas, and I think type field is a strict enum so can not use any other naming outside these type enum',
    source: 'channel',
    channelName: 'wg-creative',
    prodBehavior: 'Addie responded with authoritative schema answer',
    expectedBehavior: 'RESPOND high — squarely in Addie\'s domain, schema expertise',
  },
  {
    name: 'Addie asked by name in channel',
    who: 'Someone',
    message: 'Addie, can you explain how creative catalogs work in AdCP?',
    source: 'channel',
    channelName: 'general',
    prodBehavior: 'N/A (synthetic test)',
    expectedBehavior: 'RESPOND high — explicitly asked by name',
  },

  // ---- DM: high confidence ----
  {
    name: 'Signal provider business mechanics',
    who: 'Jean-Sébastien Prénovost',
    message: 'how does the business mechanics work for signal provider with agentic buying process?',
    source: 'dm',
    prodBehavior: 'Good multi-turn response explaining signal flow, honest about gaps',
    expectedBehavior: 'RESPOND high — core protocol question',
  },
  {
    name: 'V3 spec documentation',
    who: 'Terence Robinson (BBC)',
    message: 'could you point me to technical materials on the v3.0 spec?',
    source: 'dm',
    prodBehavior: 'Good response pointing to GitHub and docs site',
    expectedBehavior: 'RESPOND high — documentation lookup',
  },

  // ---- DM: suggest confidence ----
  {
    name: 'Who works on attribution',
    who: 'Member',
    message: 'who is working on attribution measurement standards?',
    source: 'dm',
    prodBehavior: 'N/A',
    expectedBehavior: 'RESPOND suggest — point to measurement working group',
  },

  // ---- DM: low/suggest confidence ----
  {
    name: 'Legal question in DM',
    who: 'Noga Rosenthal',
    message: 'If an AI agent gets an ad impression, does that count as an "impression?" Do we count that in our measurement reports?',
    source: 'dm',
    prodBehavior: 'N/A (this happened in channel)',
    expectedBehavior: 'RESPOND but with low/suggest confidence — brief, honest, point to measurement WG',
  },
  {
    name: 'Privacy Sandbox question',
    who: 'Member',
    message: 'how does Google Privacy Sandbox affect header bidding?',
    source: 'dm',
    prodBehavior: 'N/A',
    expectedBehavior: 'RESPOND with suggest/low — adjacent to domain, not core expertise',
  },

  // ---- DM: RFC drafting (Jeffrey Mayer / DanAds, 2026-05-01) ----
  // Same-Addie-different-answers failure: web-Addie drafted these RFCs
  // without verifying against the spec; Slack-Addie (with knowledge tools
  // routed in by channel context) corrected them. Goal: web-Addie should
  // verify before drafting, regardless of surface.
  {
    name: 'RFC: CPQ pricing task',
    who: 'Jeffrey Mayer (DanAds)',
    message:
      "draft this as a GitHub issue, but write it here so it can be shared via Slack since I don't have Github connected. The proposal: add a get_price_quote task between get_products and create_media_buy so buyer agents can submit targeting parameters and receive a firm calculated price before committing.",
    source: 'dm',
    prodBehavior:
      'Web-Addie drafted the RFC without spec verification; Slack-Addie later corrected (pricing_options + buying_mode: refine + account already address most of this).',
    expectedBehavior:
      'RESPOND — verify spec via search_docs before drafting; cite pricing_options / buying_mode / account; reframe to the narrower real gap (valid_until, rate_basis, budget-conditional pricing).',
    category: 'rfc',
    rfc: {
      expectedToolSets: ['knowledge'],
      expectedToolCalls: ['search_docs'],
      expectedFieldCitations: ['pricing_options', 'buying_mode', 'refine', 'account'],
      shouldRefusePremise: true,
    },
  },
  {
    name: 'RFC: TMP direct-sold signals capability',
    who: 'Jeffrey Mayer (DanAds)',
    message:
      'Validate this issue below against the AdCP spec, and determine if there is a solution already developed: Add a direct_sold_signals capability flag to trusted_match in get_adcp_capabilities with values "tmp_verified" or "not_supported", and a create_media_buy validation rule that rejects signals on guaranteed buys when capability is not_supported.',
    source: 'dm',
    prodBehavior:
      'Web-Addie validated the proposal as-shaped; Slack-Addie later flagged the factual error (no trusted_match key in get_adcp_capabilities; signals.features is the right place).',
    expectedBehavior:
      'RESPOND — verify get_adcp_capabilities top-level keys; reject factual premise (no trusted_match object exists); propose narrower fix in signals.features.',
    category: 'rfc',
    rfc: {
      expectedToolSets: ['knowledge'],
      expectedToolCalls: ['search_docs', 'get_schema'],
      expectedFieldCitations: ['get_adcp_capabilities', 'signals'],
      shouldRefusePremise: true,
    },
  },
  {
    name: 'RFC: bilateral trust comment on #2392',
    who: 'Jeffrey Mayer (DanAds)',
    message:
      'before adding the comment, draft the comment here for adding the buyer-identity direction, but more importantly, addressing bilateral trust. Issue #2392 seems to the the perspective of the Buyer Agent needing to trust the Seller Agent (get_products). Trust must be bilateral for both the Buyer and Seller.',
    source: 'dm',
    prodBehavior:
      'Web-Addie drafted the comment without verifying issue #2392 scope or current trust-model docs.',
    expectedBehavior:
      "RESPOND — verify issue #2392 scope and existing trust docs before drafting; cite what's already covered.",
    category: 'rfc',
    rfc: {
      expectedToolSets: ['knowledge'],
      expectedToolCalls: ['search_docs'],
      expectedFieldCitations: ['trust', 'identity'],
      shouldRefusePremise: false,
    },
  },
  {
    name: 'RFC: brand.json verification',
    who: 'Jeffrey Mayer (DanAds)',
    message:
      "/.well-known/brand.json — who determines a well known brand? Who validates this? A fraudulent company could declare themselves or be mistakenly categorized as well-known. Should we draft an issue?",
    source: 'dm',
    prodBehavior: 'Flagged as a topic; not yet drafted in current thread.',
    expectedBehavior:
      'RESPOND — verify current brand.json validation/verification model via search_docs before agreeing the gap is real. Correct premise: "well-known" is a URI convention (RFC 8615), not a trust designation.',
    category: 'rfc',
    rfc: {
      expectedToolSets: ['knowledge'],
      expectedToolCalls: ['search_docs'],
      // Any of these concepts is sufficient — the grader uses OR, not AND.
      // "well-known" / "RFC 8615" / "adagents.json" / "domain ownership" all
      // demonstrate Addie understood the verification model rather than
      // taking the caller's "well-known = certified" framing at face value.
      expectedFieldCitations: ['brand.json', 'adagents.json', 'well-known', 'domain', 'rfc 8615'],
      shouldRefusePremise: true,
    },
  },
];

async function generateResponse(message: string, confidence: ConfidenceTier): Promise<string> {
  const calibration = buildConfidenceCalibration(confidence);
  const basePrompt = await getSystemPrompt();
  const systemPrompt = [basePrompt, calibration].filter(Boolean).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', // Use the same model Addie uses in prod for chat
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : '(no text)';
}

/**
 * Variant prompt addenda for RFC drafting experiments. Selected via
 * RFC_VARIANT env (default: baseline). Each addendum is appended to the
 * system prompt only for `category: 'rfc'` scenarios so non-RFC
 * scenarios stay on the prod prompt.
 */
const RFC_VARIANTS: Record<string, string> = {
  baseline: '',
  // Variant 1 — explicit two-step: lead with what's already covered before
  // drafting. Targets the failure where Addie verifies, finds overlap, then
  // drafts anyway without surfacing the overlap to the caller first.
  'lead-with-coverage':
    "## RFC Drafting — Lead With Coverage\nWhen the caller asks you to draft a GitHub issue against the AdCP spec, follow this order: (1) call search_docs and get_schema to verify the gap, (2) BEFORE calling draft_github_issue, write a short response that names which existing fields/tasks/concepts already cover any part of the request — even if you also plan to draft. If verification reveals overlap, your text response MUST lead with phrases like 'most of this is already covered' or 'X already exists in the spec' and identify the narrower real gap. Only then offer draft_github_issue (and only for the narrower gap, not the original framing).",
  // Variant 2 — refuse-then-offer. Stronger: refuse the original framing
  // outright when verification reveals factual error; offer to draft a
  // corrected version on confirmation.
  'refuse-then-offer':
    "## RFC Drafting — Refuse Then Offer\nWhen the caller asks you to draft a GitHub issue against the AdCP spec: verify with search_docs/get_schema first. If the verification reveals the proposal extends a field that doesn't exist, conflates layers, or significantly overlaps with existing spec primitives, do NOT call draft_github_issue immediately. Instead reply with: (a) a one-sentence correction of the factual or framing error, (b) a citation of the existing primitive(s) that already cover the request, (c) the narrower real gap restated, (d) ask the caller to confirm the narrower scope before you draft. Drafting against an incorrect premise wastes review cycles and erodes trust in the protocol's apparent stability.",
};

function getRfcVariantSuffix(): { name: string; suffix: string } {
  const name = process.env.RFC_VARIANT ?? 'baseline';
  const suffix = RFC_VARIANTS[name];
  if (suffix === undefined) {
    console.warn(
      `Unknown RFC_VARIANT="${name}". Valid: ${Object.keys(RFC_VARIANTS).join(', ')}. Falling back to baseline.`,
    );
    return { name: 'baseline', suffix: '' };
  }
  return { name, suffix };
}

/**
 * Multi-turn tool loop for RFC scenarios. Gives Sonnet the stub spec tools
 * and runs until the model returns a final text response. Records every
 * tool call so the grader can score whether search_docs / get_schema were
 * invoked before any draft was emitted.
 *
 * Temperature pinned to 0 to reduce run-to-run variance — variants need a
 * clean signal, and this isn't a creativity benchmark.
 */
async function generateRfcResponse(
  message: string,
  confidence: ConfidenceTier,
): Promise<{ finalText: string; toolCalls: string[]; draftEmitted: boolean }> {
  const calibration = buildConfidenceCalibration(confidence);
  const basePrompt = await getSystemPrompt();
  const variant = getRfcVariantSuffix();
  const systemPrompt = [basePrompt, calibration, variant.suffix].filter(Boolean).join('\n\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: message }];
  const toolCalls: string[] = [];
  let draftEmitted = false;
  let finalText = '';

  // Cap the loop — RFC drafting should resolve in a few turns. A runaway
  // loop usually means the stubs are mis-shaped; fail loud rather than burn
  // budget.
  const MAX_TURNS = 6;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      temperature: 0,
      system: systemPrompt,
      tools: RFC_STUB_TOOLS as unknown as Anthropic.Tool[],
      messages,
    });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );

    if (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((tu) => {
        toolCalls.push(tu.name);
        if (tu.name === 'draft_github_issue') draftEmitted = true;
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: stubToolResult(tu.name, tu.input),
        };
      });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    finalText = textBlocks.map((t) => t.text).join('\n');
    break;
  }

  return { finalText, toolCalls, draftEmitted };
}

async function runScenario(scenario: Scenario): Promise<boolean> {
  const ctx: RoutingContext = {
    message: scenario.message,
    source: scenario.source,
    isAAOAdmin: scenario.isAdmin ?? false,
    memberContext: { is_member: true } as RoutingContext['memberContext'],
    ...(scenario.channelName ? { channelName: scenario.channelName } : {}),
  };

  const plan = await router.route(ctx);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`SCENARIO: ${scenario.name}${scenario.category ? ` [${scenario.category}]` : ''}`);
  console.log(`WHO: ${scenario.who} | SOURCE: ${scenario.source}${scenario.channelName ? ` (#${scenario.channelName})` : ''}`);
  console.log(`MESSAGE: "${scenario.message.substring(0, 120)}${scenario.message.length > 120 ? '...' : ''}"`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`PROD: ${scenario.prodBehavior}`);
  console.log(`EXPECTED: ${scenario.expectedBehavior}`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`ROUTER: action=${plan.action} | reason="${plan.reason}"`);

  // RFC scenarios: multi-turn tool loop + rfc-grader scoring.
  if (scenario.category === 'rfc' && plan.action === 'respond') {
    const confidence = plan.confidence;
    console.log(`CONFIDENCE: ${confidence}`);
    console.log(`TOOL SETS: [${plan.tool_sets.join(', ')}]`);

    const N = parseInt(process.env.RFC_RUNS ?? '1', 10);
    const passes: boolean[] = [];
    const dimCounts = { router: 0, tools: 0, citations: 0, premise: 0 };
    let lastFailures: string[] = [];
    for (let i = 0; i < N; i++) {
      const { finalText, toolCalls, draftEmitted } = await generateRfcResponse(
        scenario.message,
        confidence,
      );
      const obs: RfcRunObservations = {
        routerToolSets: plan.tool_sets,
        toolCalls,
        finalText,
        draftEmitted,
      };
      const grade = gradeRfcRun(scenario.rfc ?? {}, obs);
      passes.push(grade.passed);
      if (grade.routerOk) dimCounts.router++;
      if (grade.toolCallsOk) dimCounts.tools++;
      if (grade.citationsOk) dimCounts.citations++;
      if (grade.premiseOk) dimCounts.premise++;
      // One-line per-run summary so noisy dimensions are visible without
      // dumping every run's full transcript.
      console.log(
        `  run ${i + 1}/${N}: router=${grade.routerOk ? '✅' : '❌'} tools=${grade.toolCallsOk ? '✅' : '❌'} citations=${grade.citationsOk ? '✅' : '❌'} premise=${grade.premiseOk ? '✅' : '❌'} draft=${draftEmitted ? 'yes' : 'no'}`,
      );
      if (i === N - 1) {
        // Print only the final run's full text to keep logs scannable.
        console.log(`${'─'.repeat(80)}`);
        console.log(`TOOL CALLS: [${toolCalls.join(', ') || '(none)'}]`);
        console.log(`DRAFT EMITTED: ${draftEmitted}`);
        console.log(`ADDIE WOULD SAY:`);
        console.log(finalText.substring(0, 800) + (finalText.length > 800 ? '\n…' : ''));
        lastFailures = grade.failures;
      }
    }
    const passCount = passes.filter(Boolean).length;
    const majorityPassed = passCount > N / 2;
    if (N > 1) {
      console.log(`${'─'.repeat(80)}`);
      console.log(
        `DIMENSIONS (${N} runs): router=${dimCounts.router}/${N} tools=${dimCounts.tools}/${N} citations=${dimCounts.citations}/${N} premise=${dimCounts.premise}/${N}`,
      );
      console.log(
        `MAJORITY: ${passCount}/${N} pass → ${majorityPassed ? '✅ PASS' : '❌ FAIL'}`,
      );
    }
    if (!majorityPassed && lastFailures.length > 0) {
      for (const f of lastFailures) console.log(`  - ${f}`);
    }
    return majorityPassed;
  }

  // Legacy scenarios: shape-only, IGNORE/RESPOND prefix check.
  if (plan.action === 'respond') {
    const confidence = plan.confidence;
    console.log(`CONFIDENCE: ${confidence}`);
    console.log(`TOOL SETS: [${plan.tool_sets.join(', ')}]`);
    const response = await generateResponse(scenario.message, confidence);
    console.log(`${'─'.repeat(80)}`);
    console.log(`ADDIE WOULD SAY (${confidence}):`);
    console.log(response);
  } else if (plan.action === 'ignore') {
    console.log('→ Addie stays silent (correct for channel noise)');
  } else if (plan.action === 'react') {
    console.log(`→ Addie reacts with :${plan.emoji}:`);
  }

  const pass =
    (scenario.expectedBehavior.startsWith('IGNORE') && plan.action === 'ignore') ||
    (scenario.expectedBehavior.startsWith('RESPOND') && plan.action !== 'ignore');
  console.log(`\nGRADE: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

async function main() {
  // Filter env: REPLAY_FILTER=rfc runs only RFC scenarios; useful for
  // baseline-locking a specific failure mode without paying for the full
  // battery on every iteration. RFC_SCENARIO_MATCH is a case-insensitive
  // substring match on scenario.name for cheap single-scenario iteration.
  const filter = process.env.REPLAY_FILTER;
  const nameMatch = process.env.RFC_SCENARIO_MATCH?.toLowerCase();
  let filtered = filter ? scenarios.filter((s) => s.category === filter) : scenarios;
  if (nameMatch) {
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(nameMatch));
  }

  const variant = getRfcVariantSuffix();
  const N = parseInt(process.env.RFC_RUNS ?? '1', 10);

  console.log('Addie Qualitative Scenario Replay');
  console.log(`RFC variant: ${variant.name}${variant.suffix ? ` (+${variant.suffix.length} chars)` : ''} | runs/scenario: ${N}`);
  console.log(
    filter
      ? `Running ${filtered.length} ${filter} scenarios (filtered from ${scenarios.length})...\n`
      : `Running ${filtered.length} production scenarios...\n`,
  );

  let passed = 0;
  let failed = 0;

  for (const scenario of filtered) {
    try {
      const ok = await runScenario(scenario);
      if (ok) passed++;
      else failed++;
    } catch (error) {
      console.error(`ERROR running "${scenario.name}":`, error);
      failed++;
    }
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`SUMMARY: ${passed}/${passed + failed} scenarios behaved as expected`);
  if (failed > 0) {
    console.log(`⚠️  ${failed} scenario(s) need attention`);
  }
}

main().catch(console.error);
