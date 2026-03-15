/**
 * Full simulation run across all personas and journey scenarios.
 *
 * Runs:
 * 1. Outreach simulator — 6 personas over 90 days (deterministic engagement rules)
 * 2. User journey simulator — 5 ad tech personas across 10 scenarios (behavioral patterns)
 * 3. Prompt snapshots at key moments (with --with-prompts flag)
 *
 * Usage: npx tsx scripts/run-full-simulation.ts [--with-prompts] [--seed N]
 */

import { PERSONAS, simulate, type SimulationResult, type PromptSnapshot } from '../server/src/addie/services/outreach-simulator.js';
import {
  TEST_PERSONAS,
  generateJourney,
  analyzeJourney,
  type JourneyScenario,
  type UserPersona,
  type JourneyAnalysis,
} from '../server/src/addie/testing/user-journey-simulator.js';

const args = process.argv.slice(2);
const withPrompts = args.includes('--with-prompts');
const seedIdx = args.indexOf('--seed');
const seed = seedIdx >= 0 ? parseInt(args[seedIdx + 1], 10) : 42;

const OUTREACH_DURATION = 90;
const JOURNEY_DURATION = 30;

const ALL_SCENARIOS: JourneyScenario[] = [
  'ideal_conversion',
  'slow_burner',
  'ghost',
  'tire_kicker',
  'competitor_spy',
  'overwhelmed',
  'skeptic_converted',
  'churned_member',
  'enterprise_blocker',
  'technical_blocker',
];

// =========================================================================
// Part 1: Outreach Simulations
// =========================================================================

console.log(`\n${'='.repeat(80)}`);
console.log('PART 1: OUTREACH SIMULATIONS');
console.log(`${OUTREACH_DURATION} days, ${PERSONAS.length} personas, seed ${seed}${withPrompts ? ', prompt capture ON' : ''}`);
console.log(`${'='.repeat(80)}\n`);

const outreachResults: SimulationResult[] = [];

for (const persona of PERSONAS) {
  const result = simulate(persona, OUTREACH_DURATION, { seed, capturePrompts: withPrompts });
  outreachResults.push(result);
}

// Summary table
console.log(`${'Persona'.padEnd(25)} ${'Msgs'.padStart(5)} ${'Resp'.padStart(5)} ${'Block'.padStart(6)} ${'Avg Gap'.padStart(8)} ${'Final'.padEnd(15)} ${'Unrepl'.padStart(7)}`);
console.log(`${'─'.repeat(25)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(15)} ${'─'.repeat(7)}`);

for (const r of outreachResults) {
  const s = r.summary;
  console.log(
    `${r.persona.name.padEnd(25)} ${String(s.totalContacts).padStart(5)} ${String(s.personResponses).padStart(5)} ${String(s.totalBlocks).padStart(6)} ${String(s.averageDaysBetweenContacts || '-').padStart(8)} ${s.finalStage.padEnd(15)} ${String(s.finalUnreplied).padStart(7)}`
  );
}

// Health checks
console.log(`\n--- Health Checks ---`);
const issues: string[] = [];

for (const r of outreachResults) {
  const s = r.summary;
  if (s.totalContacts > 10 && s.personResponses === 0) {
    issues.push(`WARNING: ${r.persona.name} got ${s.totalContacts} messages with 0 responses — harassment risk`);
  }
  if (s.finalUnreplied > 3 && s.totalBlocks < 10) {
    issues.push(`WARNING: ${r.persona.name} has ${s.finalUnreplied} unreplied but only ${s.totalBlocks} blocked days — suppression may be weak`);
  }
  if (s.averageDaysBetweenContacts < 5 && s.personResponses === 0) {
    issues.push(`WARNING: ${r.persona.name} avg gap is ${s.averageDaysBetweenContacts}d with no responses — too aggressive`);
  }
}

if (issues.length === 0) {
  console.log('All outreach patterns look healthy.');
} else {
  for (const issue of issues) {
    console.log(issue);
  }
}

// =========================================================================
// Part 2: User Journey Simulations
// =========================================================================

console.log(`\n${'='.repeat(80)}`);
console.log('PART 2: USER JOURNEY SIMULATIONS');
console.log(`${TEST_PERSONAS.length} personas x ${ALL_SCENARIOS.length} scenarios = ${TEST_PERSONAS.length * ALL_SCENARIOS.length} journeys`);
console.log(`${'='.repeat(80)}\n`);

interface JourneyResult {
  persona: UserPersona;
  scenario: JourneyScenario;
  analysis: JourneyAnalysis;
  eventCount: number;
}

const journeyResults: JourneyResult[] = [];

for (const persona of TEST_PERSONAS) {
  for (const scenario of ALL_SCENARIOS) {
    try {
      const journey = generateJourney(persona, scenario, JOURNEY_DURATION);
      const analysis = analyzeJourney(journey);
      journeyResults.push({
        persona,
        scenario,
        analysis,
        eventCount: journey.events.length,
      });
    } catch (err) {
      console.log(`  ERROR: ${persona.name} / ${scenario}: ${err}`);
    }
  }
}

// Summary by persona
console.log('--- Results by Persona ---\n');
for (const persona of TEST_PERSONAS) {
  const personaResults = journeyResults.filter(r => r.persona.id === persona.id);
  console.log(`${persona.name} (${persona.role} at ${persona.company.name})`);

  for (const r of personaResults) {
    const a = r.analysis;
    const actionTypes = a.recommendedActions.map(a => a.type).join(', ') || 'none';
    const urgentActions = a.recommendedActions.filter(a => a.urgency === 'high').length;
    console.log(
      `  ${r.scenario.padEnd(22)} conv: ${String(a.conversionProbability).padStart(3)}%  actions: ${String(a.recommendedActions.length).padStart(2)} (${actionTypes})${urgentActions > 0 ? `  URGENT: ${urgentActions}` : ''}`
    );
  }
  console.log();
}

// Summary by scenario
console.log('--- Results by Scenario ---\n');
console.log(`${'Scenario'.padEnd(22)} ${'Avg Conv%'.padStart(10)} ${'Avg Actions'.padStart(12)} ${'Risks'.padStart(6)} ${'Opportunities'.padStart(14)}`);
console.log(`${'─'.repeat(22)} ${'─'.repeat(10)} ${'─'.repeat(12)} ${'─'.repeat(6)} ${'─'.repeat(14)}`);

for (const scenario of ALL_SCENARIOS) {
  const scenarioResults = journeyResults.filter(r => r.scenario === scenario);
  if (scenarioResults.length === 0) continue;

  const avgConv = Math.round(scenarioResults.reduce((sum, r) => sum + r.analysis.conversionProbability, 0) / scenarioResults.length);
  const avgActions = (scenarioResults.reduce((sum, r) => sum + r.analysis.recommendedActions.length, 0) / scenarioResults.length).toFixed(1);
  const totalRisks = scenarioResults.reduce((sum, r) => sum + r.analysis.riskFactors.length, 0);
  const totalOpps = scenarioResults.reduce((sum, r) => sum + r.analysis.opportunities.length, 0);

  console.log(
    `${scenario.padEnd(22)} ${String(avgConv + '%').padStart(10)} ${String(avgActions).padStart(12)} ${String(totalRisks).padStart(6)} ${String(totalOpps).padStart(14)}`
  );
}

// Cross-system insights
console.log(`\n${'='.repeat(80)}`);
console.log('CROSS-SYSTEM ANALYSIS');
console.log(`${'='.repeat(80)}\n`);

// Most common action recommendations
const actionCounts: Record<string, number> = {};
for (const r of journeyResults) {
  for (const a of r.analysis.recommendedActions) {
    actionCounts[a.type] = (actionCounts[a.type] || 0) + 1;
  }
}
console.log('Action recommendation frequency:');
for (const [type, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count} times`);
}

// Most common risk factors
const riskCounts: Record<string, number> = {};
for (const r of journeyResults) {
  for (const risk of r.analysis.riskFactors) {
    riskCounts[risk] = (riskCounts[risk] || 0) + 1;
  }
}
console.log('\nTop risk factors:');
for (const [risk, count] of Object.entries(riskCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  ${count}x: ${risk}`);
}

// Most common opportunities
const oppCounts: Record<string, number> = {};
for (const r of journeyResults) {
  for (const opp of r.analysis.opportunities) {
    oppCounts[opp] = (oppCounts[opp] || 0) + 1;
  }
}
console.log('\nTop opportunities:');
for (const [opp, count] of Object.entries(oppCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  ${count}x: ${opp}`);
}

// =========================================================================
// Part 3: Prompt Snapshots (if --with-prompts)
// =========================================================================

if (withPrompts) {
  const allSnapshots: Array<{ persona: string; snapshot: PromptSnapshot }> = [];
  for (const r of outreachResults) {
    for (const s of r.snapshots) {
      allSnapshots.push({ persona: r.persona.name, snapshot: s });
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('PART 3: PROMPT SNAPSHOTS');
  console.log(`${allSnapshots.length} snapshots at key engagement moments`);
  console.log(`${'='.repeat(80)}\n`);

  // Summary by persona
  for (const r of outreachResults) {
    if (r.snapshots.length === 0) continue;
    console.log(`${r.persona.name}:`);
    for (const s of r.snapshots) {
      console.log(`  day ${String(s.day).padStart(3)} [${s.moment.padEnd(20)}] ${s.channel.padEnd(5)} stage=${s.stage} unreplied=${s.unrepliedCount}`);
    }
    console.log();
  }

  // Summary by moment type
  console.log('--- Snapshots by moment type ---');
  const momentCounts: Record<string, number> = {};
  for (const { snapshot } of allSnapshots) {
    momentCounts[snapshot.moment] = (momentCounts[snapshot.moment] ?? 0) + 1;
  }
  for (const [moment, count] of Object.entries(momentCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${moment}: ${count}`);
  }

  console.log(`\nTo run qualitative expert review: npx tsx scripts/review-engagement-quality.ts`);
}

console.log(`\n${'='.repeat(80)}`);
console.log(`SIMULATION COMPLETE — ${outreachResults.length} outreach + ${journeyResults.length} journey simulations${withPrompts ? ` + ${outreachResults.reduce((s, r) => s + r.snapshots.length, 0)} prompt snapshots` : ''}`);
console.log(`${'='.repeat(80)}\n`);
