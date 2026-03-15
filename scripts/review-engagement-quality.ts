/**
 * Expert qualitative review of engagement prompts.
 *
 * Runs simulations with prompt snapshot capture, then feeds each snapshot to
 * Claude for structured evaluation against a rubric. Catches tone mismatches,
 * surveillance signals, and inappropriate messaging that quantitative tests miss.
 *
 * Usage: npx tsx scripts/review-engagement-quality.ts
 * Requires ANTHROPIC_API_KEY or ADDIE_ANTHROPIC_API_KEY env var.
 *
 * Options:
 *   --persona <name>   Review a single persona (e.g. "The Ghost")
 *   --moment <type>    Review a single moment type (e.g. "monthly_pulse")
 *   --verbose          Show full prompts and review details
 */

import Anthropic from '@anthropic-ai/sdk';
import { PERSONAS, simulate, type PromptSnapshot, type SimulatedPersona } from '../server/src/addie/services/outreach-simulator.js';

const SEED = 42;
const DURATION = 90;

// ---------------------------------------------------------------------------
// Review rubric
// ---------------------------------------------------------------------------

const REVIEW_RUBRIC = `You are an expert reviewer evaluating the quality of AI-generated outreach prompts for a professional community (AgenticAdvertising.org).

You will see a system prompt and user prompt that would be sent to an AI assistant (Addie) to compose a message to a community member. Your job is to evaluate whether the prompt would produce an appropriate, effective message.

Score each dimension 1-5 (1 = serious problem, 3 = acceptable, 5 = excellent):

## Dimensions

### Tone match (tone)
Does the prompt guide appropriate tone for this person's stage and situation?
- 1: Tone guidance contradicts the situation (e.g., enthusiastic for someone who's been ignored 3 times)
- 3: Tone is generic but not harmful
- 5: Tone guidance perfectly matches the relationship stage and history

### Topic relevance (topic)
Are the engagement opportunities well-chosen for this person's situation?
- 1: Opportunities are irrelevant or pushy given the context
- 3: Opportunities are reasonable but generic
- 5: Opportunities feel perfectly tailored to what this person would actually want

### Surveillance signal (surveillance)
Would the resulting message make the person feel watched or tracked?
- 1: Prompt exposes tracking data (unreplied counts, engagement scores, days since last message)
- 3: Some data leaks but would be hard for the AI to reference directly
- 5: No tracking data visible; knowledge feels natural and conversational

### CTA appropriateness (cta)
Is the ask level right for this moment?
- 1: Asks for too much (e.g., heavy CTA in a monthly pulse) or too little (no guidance for a welcome)
- 3: CTA guidance is present but could be better calibrated
- 5: CTA level perfectly matches the moment (welcome = soft question, pulse = pure value, follow-up = gentle nudge)

### Channel voice (channel)
Does the prompt correctly guide channel-appropriate writing?
- 1: Email guidance given for Slack or vice versa
- 3: Channel guidance is present but generic
- 5: Channel-specific voice guidance is clear and would produce natural-sounding messages

### Conversation continuity (continuity)
Does the conversation history create natural flow, or would the message feel disconnected?
- 1: No conversation history when there should be, or history suggests repetitive messaging
- 3: History is present but the AI might struggle to build on it naturally
- 5: History provides clear context for a natural continuation

## Response format
Respond with JSON only:
{
  "scores": {
    "tone": <1-5>,
    "topic": <1-5>,
    "surveillance": <1-5>,
    "cta": <1-5>,
    "channel": <1-5>,
    "continuity": <1-5>
  },
  "flags": ["<any serious concerns — empty array if none>"],
  "summary": "<1-2 sentence overall assessment>"
}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewScores {
  tone: number;
  topic: number;
  surveillance: number;
  cta: number;
  channel: number;
  continuity: number;
}

interface ReviewResult {
  persona: string;
  moment: string;
  day: number;
  channel: string;
  stage: string;
  scores: ReviewScores;
  flags: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ADDIE_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY or ADDIE_ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // Parse CLI flags
  const args = process.argv.slice(2);
  const personaFilter = getArg(args, '--persona');
  const momentFilter = getArg(args, '--moment');
  const verbose = args.includes('--verbose');

  // Run simulations with prompt capture
  const personas = personaFilter
    ? PERSONAS.filter(p => p.name.toLowerCase().includes(personaFilter.toLowerCase()))
    : PERSONAS;

  if (personas.length === 0) {
    console.error(`No persona matching "${personaFilter}"`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('ENGAGEMENT QUALITY REVIEW');
  console.log(`${personas.length} personas, ${DURATION} days, seed ${SEED}`);
  console.log(`${'='.repeat(80)}\n`);

  // Collect all snapshots
  const allSnapshots: Array<{ persona: SimulatedPersona; snapshot: PromptSnapshot }> = [];
  for (const persona of personas) {
    const result = simulate(persona, DURATION, { seed: SEED, capturePrompts: true });
    for (const snapshot of result.snapshots) {
      if (momentFilter && snapshot.moment !== momentFilter) continue;
      allSnapshots.push({ persona, snapshot });
    }
  }

  console.log(`${allSnapshots.length} prompt snapshots to review\n`);

  // Review each snapshot
  const results: ReviewResult[] = [];
  for (let i = 0; i < allSnapshots.length; i++) {
    const { persona, snapshot } = allSnapshots[i];
    const label = `${persona.name} / ${snapshot.moment} (day ${snapshot.day})`;
    process.stdout.write(`  [${i + 1}/${allSnapshots.length}] ${label}...`);

    try {
      const review = await reviewSnapshot(client, persona, snapshot, verbose);
      results.push(review);

      const avg = Object.values(review.scores).reduce((a, b) => a + b, 0) / 6;
      const flagStr = review.flags.length > 0 ? ` ⚠ ${review.flags.length} flag(s)` : '';
      console.log(` avg ${avg.toFixed(1)}/5${flagStr}`);
    } catch (err: any) {
      console.log(` ERROR: ${err.message}`);
    }
  }

  // Summary report
  printReport(results, verbose);
}

async function reviewSnapshot(
  client: Anthropic,
  persona: SimulatedPersona,
  snapshot: PromptSnapshot,
  verbose: boolean,
): Promise<ReviewResult> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    temperature: 0,
    system: REVIEW_RUBRIC,
    messages: [{
      role: 'user',
      content: `## Persona context
Name: ${persona.name}
Description: ${persona.description}
Response behavior: ${persona.responseBehavior}
Company: ${persona.company?.name ?? 'Unknown'} (${persona.company?.type ?? 'unknown'})

## Simulation moment
Type: ${snapshot.moment}
Day: ${snapshot.day} of ${DURATION}
Channel: ${snapshot.channel}
Stage: ${snapshot.stage}
Unreplied count: ${snapshot.unrepliedCount}
Contact reason: ${snapshot.contactReason}

## System prompt being evaluated
${snapshot.systemPrompt}

## User prompt being evaluated
${snapshot.userPrompt}`,
    }],
  });

  const text = response.content[0];
  if (text.type !== 'text') throw new Error('Unexpected response type');

  // Parse JSON, stripping markdown fences if present
  let jsonStr = text.text.trim();
  const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const parsed = JSON.parse(jsonStr);

  if (verbose) {
    console.log(`\n    Scores: ${JSON.stringify(parsed.scores)}`);
    console.log(`    Summary: ${parsed.summary}`);
    if (parsed.flags.length > 0) {
      console.log(`    Flags: ${parsed.flags.join('; ')}`);
    }
  }

  return {
    persona: persona.name,
    moment: snapshot.moment,
    day: snapshot.day,
    channel: snapshot.channel,
    stage: snapshot.stage,
    scores: parsed.scores,
    flags: parsed.flags ?? [],
    summary: parsed.summary,
  };
}

function printReport(results: ReviewResult[], verbose: boolean) {
  if (results.length === 0) {
    console.log('\nNo results to report.');
    return;
  }

  // Dimension averages
  console.log(`\n${'='.repeat(80)}`);
  console.log('QUALITY REPORT');
  console.log(`${'='.repeat(80)}\n`);

  const dimensions = ['tone', 'topic', 'surveillance', 'cta', 'channel', 'continuity'] as const;

  // Overall averages
  console.log('--- Overall dimension scores ---\n');
  for (const dim of dimensions) {
    const scores = results.map(r => r.scores[dim]);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const bar = '█'.repeat(Math.round(avg)) + '░'.repeat(5 - Math.round(avg));
    const warning = min <= 2 ? ' ⚠' : '';
    console.log(`  ${dim.padEnd(14)} ${bar} ${avg.toFixed(1)}/5  (min: ${min})${warning}`);
  }

  // By persona
  console.log('\n--- Scores by persona ---\n');
  const personaNames = [...new Set(results.map(r => r.persona))];
  console.log(`${'Persona'.padEnd(25)} ${'Tone'.padStart(5)} ${'Topic'.padStart(6)} ${'Surv'.padStart(5)} ${'CTA'.padStart(5)} ${'Chan'.padStart(5)} ${'Cont'.padStart(5)} ${'Avg'.padStart(5)}`);
  console.log(`${'─'.repeat(25)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)}`);

  for (const name of personaNames) {
    const personaResults = results.filter(r => r.persona === name);
    const avgs: Record<string, number> = {};
    for (const dim of dimensions) {
      avgs[dim] = personaResults.reduce((s, r) => s + r.scores[dim], 0) / personaResults.length;
    }
    const overall = Object.values(avgs).reduce((a, b) => a + b, 0) / dimensions.length;
    console.log(
      `${name.padEnd(25)} ${avgs.tone.toFixed(1).padStart(5)} ${avgs.topic.toFixed(1).padStart(6)} ${avgs.surveillance.toFixed(1).padStart(5)} ${avgs.cta.toFixed(1).padStart(5)} ${avgs.channel.toFixed(1).padStart(5)} ${avgs.continuity.toFixed(1).padStart(5)} ${overall.toFixed(1).padStart(5)}`
    );
  }

  // By moment type
  console.log('\n--- Scores by moment ---\n');
  const momentTypes = [...new Set(results.map(r => r.moment))];
  console.log(`${'Moment'.padEnd(22)} ${'Tone'.padStart(5)} ${'Topic'.padStart(6)} ${'Surv'.padStart(5)} ${'CTA'.padStart(5)} ${'Chan'.padStart(5)} ${'Cont'.padStart(5)} ${'Avg'.padStart(5)}`);
  console.log(`${'─'.repeat(22)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)}`);

  for (const moment of momentTypes) {
    const momentResults = results.filter(r => r.moment === moment);
    const avgs: Record<string, number> = {};
    for (const dim of dimensions) {
      avgs[dim] = momentResults.reduce((s, r) => s + r.scores[dim], 0) / momentResults.length;
    }
    const overall = Object.values(avgs).reduce((a, b) => a + b, 0) / dimensions.length;
    console.log(
      `${moment.padEnd(22)} ${avgs.tone.toFixed(1).padStart(5)} ${avgs.topic.toFixed(1).padStart(6)} ${avgs.surveillance.toFixed(1).padStart(5)} ${avgs.cta.toFixed(1).padStart(5)} ${avgs.channel.toFixed(1).padStart(5)} ${avgs.continuity.toFixed(1).padStart(5)} ${overall.toFixed(1).padStart(5)}`
    );
  }

  // Flags
  const allFlags = results.filter(r => r.flags.length > 0);
  if (allFlags.length > 0) {
    console.log(`\n--- Flags (${allFlags.length} snapshots) ---\n`);
    for (const r of allFlags) {
      console.log(`  ${r.persona} / ${r.moment} (day ${r.day}):`);
      for (const flag of r.flags) {
        console.log(`    ⚠ ${flag}`);
      }
    }
  }

  // Low scores
  const lowScores = results.filter(r =>
    Object.values(r.scores).some(s => s <= 2)
  );
  if (lowScores.length > 0) {
    console.log(`\n--- Low scores (≤2) requiring attention ---\n`);
    for (const r of lowScores) {
      const lows = Object.entries(r.scores)
        .filter(([, v]) => v <= 2)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      console.log(`  ${r.persona} / ${r.moment} (day ${r.day}): ${lows}`);
      console.log(`    ${r.summary}`);
    }
  }

  // Overall verdict
  const globalAvg = results.reduce(
    (sum, r) => sum + Object.values(r.scores).reduce((a, b) => a + b, 0) / 6,
    0,
  ) / results.length;
  const flagCount = results.reduce((s, r) => s + r.flags.length, 0);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`VERDICT: ${globalAvg.toFixed(1)}/5 average across ${results.length} snapshots, ${flagCount} flag(s)`);
  if (globalAvg >= 4.0 && flagCount === 0) {
    console.log('Quality: GOOD — prompts should produce appropriate messages');
  } else if (globalAvg >= 3.0) {
    console.log('Quality: ACCEPTABLE — some areas need attention');
  } else {
    console.log('Quality: NEEDS WORK — review flagged items before deploying');
  }
  console.log(`${'='.repeat(80)}\n`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main().catch(console.error);
