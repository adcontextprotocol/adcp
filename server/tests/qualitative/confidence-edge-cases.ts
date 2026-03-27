/**
 * Quick confidence tier edge case tests.
 * Run: npx tsx server/tests/qualitative/confidence-edge-cases.ts
 */
import { AddieRouter } from '../../src/addie/router.js';
import type { RoutingContext } from '../../src/addie/router.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('ANTHROPIC_API_KEY required'); process.exit(1); }

const r = new AddieRouter(apiKey);

interface Case {
  name: string;
  msg: string;
  source?: 'dm' | 'channel';
  expectedConfidence: string;
}

const cases: Case[] = [
  // Should be HIGH — answer exists in docs/schemas
  { name: 'Schema enum values', msg: 'what are the valid values for format_category in the creative schema?', expectedConfidence: 'high' },
  { name: 'What is AdCP', msg: 'what is AdCP?', expectedConfidence: 'high' },
  { name: 'Signal catalog sync', msg: 'how does the signal catalog sync work in AdCP?', expectedConfidence: 'high' },
  { name: 'Joining a working group', msg: 'how do I join a working group?', expectedConfidence: 'high' },

  // Should be SUGGEST — topic relates to AdCP but answer isn't in docs
  { name: 'Impression counting for AI agents', msg: 'If an AI agent gets an ad impression, does that count as an "impression?" Do we count that in our measurement reports?', expectedConfidence: 'suggest' },
  { name: 'Commercial terms for signals', msg: 'who pays the signal provider in an agentic buy? Is it by CPM?', expectedConfidence: 'suggest' },
  { name: 'Who defines measurement standards', msg: 'who is defining the measurement standards for AI agent impressions?', expectedConfidence: 'suggest' },
  { name: 'Privacy Sandbox impact', msg: 'how does Google Privacy Sandbox affect header bidding?', expectedConfidence: 'suggest' },
];

async function run() {
  console.log('Confidence Edge Cases\n');
  let pass = 0, fail = 0;

  for (const c of cases) {
    const plan = await r.route({
      message: c.msg,
      source: c.source || 'dm',
      isAAOAdmin: false,
      memberContext: { is_member: true } as RoutingContext['memberContext'],
    });

    const conf = plan.action === 'respond' ? plan.confidence : plan.action;
    const ok = conf === c.expectedConfidence;
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} [${conf}] expected=${c.expectedConfidence} | ${c.name}`);
    if (!ok && plan.action === 'respond') {
      console.log(`   reason: ${plan.reason.substring(0, 150)}`);
    }
    if (ok) pass++; else fail++;
  }

  console.log(`\n${pass}/${pass + fail} correct`);
}

run().catch(console.error);
