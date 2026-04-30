/**
 * Smoke-test the shape-grader + assembled-prompt pipeline that the shadow
 * evaluator now relies on.
 *
 * Two modes:
 *   - Default (no env var): grades a fixture set including the registry/Katie
 *     thread, prints the shape report. No API calls. Useful for verifying the
 *     grader catches the patterns we care about.
 *   - With ANTHROPIC_API_KEY set: also generates a fresh Addie response
 *     against the Katie question using the real assembled prompt + Haiku
 *     (or SHADOW_EVAL_MODEL override) and prints the shape report on the
 *     live response. This is the end-to-end smoke test of the shadow path.
 *
 * Run:
 *   npx tsx server/scripts/shape-grader-smoke.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx server/scripts/shape-grader-smoke.ts
 *   ANTHROPIC_API_KEY=sk-... SHADOW_EVAL_MODEL=primary npx tsx server/scripts/shape-grader-smoke.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { gradeShape } from '../src/addie/testing/shape-grader.js';
import { loadRules } from '../src/addie/rules/index.js';
import { ADDIE_TOOL_REFERENCE } from '../src/addie/prompts.js';
import { ModelConfig, AddieModelConfig } from '../src/config/models.js';

const KATIE_QUESTION =
  'How does an agent get registered on the AAO registry? Do you have to pay and do you have to be an AAO member?';

const KATIE_ADDIE_RESPONSE = `Here's how agent registration on the AAO registry works:

**Two paths to get an agent into the registry:**

1. **Self-hosted via adagents.json (free, no membership required)**
Publishers can declare their authorized agents by hosting a /.well-known/adagents.json file on their domain. The registry crawls these automatically — when the crawler discovers an agent URL there, it's indexed as an agent.discovered event. No payment, no membership needed. This is the authoritative path.

2. **Registered via the dashboard (membership required for full visibility)**
Members can register an agent through Addie or the dashboard using the save_agent flow. New agents land with members_only visibility — discoverable to Professional-tier (or higher) members but not publicly listed. To promote an agent to full public listing in the directory and brand.json, you go through the dashboard publish flow, which requires an API-access tier (Builder at $2,500/year or higher).

**Summary on membership/payment:**
- Reading the registry (resolving brands, discovering agents, validating authorization) is **free and public** — no auth required for most endpoints.
- Getting an agent discovered via adagents.json is also **free** — just host the file.
- Public directory listing of your agent requires at minimum a **Builder membership ($2,500/year)**, which includes API access.
- The members-only visibility tier sits at **Professional ($250/year)**.

The full registry API reference is at docs.adcontextprotocol.org/docs/registry — worth a read if you're deciding which path fits your situation. What kind of agent are you looking to register?`;

const BRIAN_TLDR =
  "TLDR: it's free and you don't have to be a member BUT only members can see your agent until you are a member.\n\nFree registration: members can see your agent\nPaid registration: anybody can see your agent";

function printReport(label: string, question: string, response: string) {
  const r = gradeShape(question, response);
  console.log(`\n=== ${label} ===`);
  console.log('Question words:', r.question.wordCount, '| multi-part:', r.question.isMultiPart, '| expected max:', r.question.expectedMaxWords);
  console.log('Response words:', r.response.wordCount, '| ratio:', r.violations.ratioToExpected.toFixed(2));
  console.log('Bold headings:', r.response.boldHeadingCount);
  console.log('Bullets:', r.response.bulletCount, '| numbered:', r.response.numberedListCount);
  console.log('Ends with question:', r.response.endsWithQuestion);
  console.log('Default template:', r.response.usesDefaultTemplate);
  console.log('Sign-in opener:', r.response.signInOpenerHit);
  console.log('Banned rituals:', r.response.bannedRitualHits);
  console.log('Violations:', r.violationLabels.length === 0 ? '(none)' : r.violationLabels.join(', '));
}

async function main() {
  console.log('## Static fixtures (no API call)');
  printReport('Katie/registry — Addie response (the bad case)', KATIE_QUESTION, KATIE_ADDIE_RESPONSE);
  printReport("Katie/registry — Brian's TLDR (the good case)", KATIE_QUESTION, BRIAN_TLDR);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('\n(skip live API smoke — set ANTHROPIC_API_KEY to also test live shadow generation)');
    return;
  }

  console.log('\n## Live shadow generation (real prompt + selected model)');
  let systemPrompt: string;
  try {
    systemPrompt = `${loadRules()}\n\n---\n\n${ADDIE_TOOL_REFERENCE}`;
  } catch (err) {
    console.error('Failed to load rules:', err);
    process.exitCode = 1;
    return;
  }
  console.log('Assembled prompt size:', systemPrompt.length, 'chars');

  const override = process.env.SHADOW_EVAL_MODEL?.trim();
  let model = ModelConfig.fast;
  if (override === 'primary' || override === 'chat') model = AddieModelConfig.chat;
  else if (override === 'depth') model = ModelConfig.depth;
  else if (override === 'precision') model = ModelConfig.precision;
  else if (override) model = override;

  console.log('Model:', model);

  const client = new Anthropic({ apiKey });
  const t0 = Date.now();
  const result = await client.messages.create({
    model,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: KATIE_QUESTION }],
  });
  const elapsedMs = Date.now() - t0;
  const liveResponse = result.content[0].type === 'text' ? result.content[0].text : '';
  console.log('Generated in', elapsedMs, 'ms');
  console.log('--- Response ---');
  console.log(liveResponse);
  console.log('--- /Response ---');
  printReport('Katie/registry — LIVE shadow response', KATIE_QUESTION, liveResponse);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
