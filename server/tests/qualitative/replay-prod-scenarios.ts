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
import type { RoutingContext, ExecutionPlan, ConfidenceTier } from '../../src/addie/router.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const adminApiKey = process.env.ADMIN_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

const router = new AddieRouter(apiKey);
const client = new Anthropic({ apiKey });

// Fetch Addie's real system prompt from prod
let realSystemPrompt: string | null = null;
async function getSystemPrompt(): Promise<string> {
  if (realSystemPrompt) return realSystemPrompt;

  if (adminApiKey) {
    try {
      const res = await fetch('https://agenticadvertising.org/api/admin/addie/rules/system-prompt', {
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

async function runScenario(scenario: Scenario): Promise<void> {
  const ctx: RoutingContext = {
    message: scenario.message,
    source: scenario.source,
    isAAOAdmin: scenario.isAdmin ?? false,
    memberContext: { is_member: true } as RoutingContext['memberContext'],
    ...(scenario.channelName ? { channelName: scenario.channelName } : {}),
  };

  const plan = await router.route(ctx);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`SCENARIO: ${scenario.name}`);
  console.log(`WHO: ${scenario.who} | SOURCE: ${scenario.source}${scenario.channelName ? ` (#${scenario.channelName})` : ''}`);
  console.log(`MESSAGE: "${scenario.message.substring(0, 120)}${scenario.message.length > 120 ? '...' : ''}"`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`PROD: ${scenario.prodBehavior}`);
  console.log(`EXPECTED: ${scenario.expectedBehavior}`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`ROUTER: action=${plan.action} | reason="${plan.reason}"`);

  if (plan.action === 'respond') {
    const confidence = plan.confidence;
    console.log(`CONFIDENCE: ${confidence}`);
    console.log(`TOOL SETS: [${plan.tool_sets.join(', ')}]`);

    // Generate actual response
    const response = await generateResponse(scenario.message, confidence);
    console.log(`${'─'.repeat(80)}`);
    console.log(`ADDIE WOULD SAY (${confidence}):`);
    console.log(response);
  } else if (plan.action === 'ignore') {
    console.log('→ Addie stays silent (correct for channel noise)');
  } else if (plan.action === 'react') {
    console.log(`→ Addie reacts with :${plan.emoji}:`);
  }

  // Grade
  const pass =
    (scenario.expectedBehavior.startsWith('IGNORE') && plan.action === 'ignore') ||
    (scenario.expectedBehavior.startsWith('RESPOND') && plan.action === 'respond');
  console.log(`\nGRADE: ${pass ? '✅ PASS' : '❌ FAIL'}`);
}

async function main() {
  console.log('Addie Qualitative Scenario Replay');
  console.log(`Running ${scenarios.length} production scenarios...\n`);

  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    try {
      await runScenario(scenario);
      // Simple pass check
      const plan = await router.route({
        message: scenario.message,
        source: scenario.source,
        isAAOAdmin: scenario.isAdmin ?? false,
        memberContext: { is_member: true } as RoutingContext['memberContext'],
        ...(scenario.channelName ? { channelName: scenario.channelName } : {}),
      });
      const expectedIgnore = scenario.expectedBehavior.startsWith('IGNORE');
      const isCorrect = expectedIgnore ? plan.action === 'ignore' : plan.action !== 'ignore';
      if (isCorrect) passed++;
      else failed++;
    } catch (error) {
      console.error(`ERROR: ${error}`);
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
