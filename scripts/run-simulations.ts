/**
 * Run outreach simulations locally and print results.
 * Usage: npx tsx scripts/run-simulations.ts
 */

import { PERSONAS, simulate, type SimulationResult } from '../server/src/addie/services/outreach-simulator.js';

const DURATION = 90; // days

console.log(`\n${'='.repeat(80)}`);
console.log(`OUTREACH SIMULATION — ${DURATION} days, ${PERSONAS.length} personas`);
console.log(`${'='.repeat(80)}\n`);

for (const persona of PERSONAS) {
  const result = simulate(persona, DURATION);
  printResult(result);
}

function printResult(r: SimulationResult) {
  const s = r.summary;
  const p = r.persona;

  console.log(`${'─'.repeat(80)}`);
  console.log(`${p.name} — ${p.description}`);
  console.log(`  Start: ${p.stage} | Slack: ${p.hasSlack} | Email: ${p.hasEmail} | Response: ${p.responseBehavior}${p.responseProbability ? ` (${Math.round(p.responseProbability * 100)}%)` : ''}${p.respondAfterN ? ` (after ${p.respondAfterN})` : ''}`);
  console.log();

  // Key metrics
  console.log(`  Messages sent:    ${s.totalContacts}`);
  console.log(`  Person responses: ${s.personResponses}`);
  console.log(`  Days skipped:     ${s.totalSkips}`);
  console.log(`  Days blocked:     ${s.totalBlocks}`);
  console.log(`  Final stage:      ${s.finalStage}`);
  console.log(`  Final unreplied:  ${s.finalUnreplied}`);
  if (s.averageDaysBetweenContacts > 0) {
    console.log(`  Avg days between: ${s.averageDaysBetweenContacts}`);
  }
  console.log();

  // Day-by-day timeline (compact)
  const dayMap: Record<number, string> = {};
  for (const e of r.events) {
    // Prefer more interesting events
    if (!dayMap[e.day] || e.action === 'contacted' || e.action === 'person_responded') {
      dayMap[e.day] = e.action;
    }
  }

  let timeline = '  ';
  for (let d = 0; d < r.durationDays; d++) {
    const action = dayMap[d];
    if (action === 'contacted') timeline += '\x1b[34mC\x1b[0m'; // blue
    else if (action === 'person_responded') timeline += '\x1b[32mR\x1b[0m'; // green
    else if (action === 'blocked') timeline += '\x1b[31mB\x1b[0m'; // red
    else if (action === 'skipped') timeline += '\x1b[90m·\x1b[0m'; // gray
    else timeline += ' ';
  }
  console.log(`  Timeline (${r.durationDays}d): C=contacted R=responded B=blocked ·=skipped`);
  console.log(timeline);

  // Contact details
  const contacts = r.events.filter(e => e.action === 'contacted');
  if (contacts.length > 0) {
    console.log();
    console.log(`  Contact log:`);
    for (const c of contacts) {
      console.log(`    Day ${String(c.day).padStart(3)}: ${c.channel ?? '?'} — ${c.reason} (unreplied: ${c.unrepliedCount}, stage: ${c.stage})`);
    }
  }

  const responses = r.events.filter(e => e.action === 'person_responded');
  if (responses.length > 0) {
    console.log(`  Response log:`);
    for (const c of responses) {
      console.log(`    Day ${String(c.day).padStart(3)}: responded (stage: ${c.stage})`);
    }
  }

  console.log();
}

// Summary comparison
console.log(`${'='.repeat(80)}`);
console.log('SUMMARY COMPARISON');
console.log(`${'='.repeat(80)}`);
console.log();
console.log(`${'Persona'.padEnd(25)} ${'Msgs'.padStart(5)} ${'Resp'.padStart(5)} ${'Block'.padStart(6)} ${'Avg Gap'.padStart(8)} ${'Final'.padEnd(15)} ${'Unrepl'.padStart(7)}`);
console.log(`${'─'.repeat(25)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(15)} ${'─'.repeat(7)}`);

for (const persona of PERSONAS) {
  const r = simulate(persona, DURATION);
  const s = r.summary;
  console.log(
    `${persona.name.padEnd(25)} ${String(s.totalContacts).padStart(5)} ${String(s.personResponses).padStart(5)} ${String(s.totalBlocks).padStart(6)} ${String(s.averageDaysBetweenContacts || '-').padStart(8)} ${s.finalStage.padEnd(15)} ${String(s.finalUnreplied).padStart(7)}`
  );
}
console.log();
