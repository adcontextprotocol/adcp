#!/usr/bin/env node
'use strict';

/**
 * Differential coverage run: generate seeded scenarios, compute owed periods
 * with the reference model, the TypeScript SDK and the Python SDK, and diff
 * them. On a disagreement, minimize the scenario and save it as a candidate
 * vector; exit 1.
 *
 *   node tests/interop/differential/run.cjs [--count 500] [--seed <first seed>] [--seeds 37,79]
 *                                       [--batch 100] [--out <dir>] [--minimize-per-signature 2]
 *                                       [--vectors]
 *
 * --seed defaults to one derived from today's date, so each nightly run explores
 * new scenarios; the seed is printed, and --seeds replays specific ones.
 * --vectors also replays every case in vectors.json through both SDKs first.
 * Candidates and summary.json / summary.md go to --out
 * (default $ADCP_INTEROP_OUT or tests/interop/differential/out).
 */

const fs = require('node:fs');
const path = require('node:path');
const env = require('../lib/env.cjs');
const { generateScenario } = require('./generate.cjs');
const { validateInput, validateCase } = require('./validate.cjs');
const { startImplementations, signature, disagreements } = require('./implementations.cjs');
const { minimize } = require('./minimize.cjs');

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[(i += 1)];
    out[key] = value;
  }
  return out;
}

const SPEC_REFS = [
  'static/schemas/source/core/reporting-subscription.json#/x-adcp-validation/coverage',
  'static/schemas/source/core/reporting-schedule.json',
];

function candidateCase(seed, flavors, input, results, steps, sig) {
  const ref = results.reference;
  const testCase = {
    id: `candidate-${seed}`,
    name: `differential candidate ${seed} (${flavors.join(', ')})`,
    origin: 'adcp',
    rule:
      `PROVISIONAL, from tests/interop differential testing: ${sig}. ` +
      'The expected rows or error below are the reference model\'s and have not been derived from the spec text; ' +
      'derive them from the text before promoting this case into vectors.json.',
    spec_refs: SPEC_REFS,
  };
  if (ref.ok) {
    testCase.timezones = ref.timezones ?? [];
    testCase.input = input;
    testCase.expected = ref.rows;
    testCase.expected_obligations = ref.obligations;
  } else {
    testCase.input = input;
    testCase.expected_error = {
      code: ref.error.code ?? 'COVERAGE_INPUT_INVALID',
      detail: ref.error.detail ?? 'invalid_input',
      wire_valid: validateInput(input).length === 0,
    };
  }
  return { case: testCase, observed: results, minimization_steps: steps };
}

async function main() {
  const opts = args();
  env.checkEnv();
  const outDir = path.resolve(opts.out || process.env.ADCP_INTEROP_OUT || path.join(__dirname, 'out'));
  fs.mkdirSync(path.join(outDir, 'candidates'), { recursive: true });
  const count = Number(opts.count ?? 500);
  const batchSize = Number(opts.batch ?? 100);
  const perSignature = Number(opts['minimize-per-signature'] ?? 2);
  const firstSeed = Number(opts.seed ?? Math.floor(Date.now() / 86_400_000) * 100_000);
  const seeds = opts.seeds ? String(opts.seeds).split(',').map(Number) : Array.from({ length: count }, (_, i) => firstSeed + i);
  const versions = env.versions();
  console.log(`differential coverage: @adcp/sdk ${versions.ts}, adcp ${versions.py}, tzdata ${versions.tzdata}`);
  console.log(seeds.length ? `seeds ${seeds[0]}..${seeds[seeds.length - 1]} (${seeds.length})` : "no generated scenarios");

  const impls = startImplementations();
  const summary = {
    versions,
    first_seed: seeds[0],
    scenarios: 0,
    rejected_invalid: 0,
    outcomes: { rows: 0, empty: 0, error: 0 },
    flavors: {},
    vectors: null,
    signatures: {},
    candidates: [],
  };
  const failures = [];

  try {
    if (opts.vectors) {
      const vectors = JSON.parse(fs.readFileSync(path.join(env.ROOT, 'static/compliance/source/test-vectors/reporting-subscriptions/vectors.json'), 'utf8'));
      const results = await impls.run(vectors.cases.map(c => c.input), ['ts', 'py']);
      const bad = [];
      vectors.cases.forEach((c, i) => {
        const expected = c.expected_error
          ? { ok: false, error: { kind: 'coverage_input', code: c.expected_error.code, detail: c.expected_error.detail } }
          : { ok: true, rows: c.expected, obligations: c.expected_obligations };
        const found = disagreements({ vector: expected, ts: results.ts[i], py: results.py[i] });
        if (found.length) bad.push({ id: c.id, disagreements: found.map(({ pair, kind, detail }) => ({ pair, kind, detail })) });
      });
      summary.vectors = { cases: vectors.cases.length, disagreements: bad };
      console.log(`vectors.json: ${vectors.cases.length} cases, ${bad.length} with disagreements`);
      for (const entry of bad) console.log(`  ${entry.id}: ${entry.disagreements.map(d => `${d.pair} ${d.detail}`).join('; ')}`);
    }

    for (let offset = 0; offset < seeds.length; offset += batchSize) {
      const scenarios = [];
      for (const seed of seeds.slice(offset, offset + batchSize)) {
        const scenario = generateScenario(seed);
        const problems = validateInput(scenario.input);
        scenario.wireValid = problems.length === 0;
        // Only deliberately invalid scenarios may fail the wire schemas.
        if (!scenario.wireValid && !scenario.flavors.includes('invalid')) {
          summary.rejected_invalid += 1;
          continue;
        }
        scenarios.push(scenario);
      }
      const results = await impls.run(scenarios.map(s => s.input));
      scenarios.forEach((scenario, i) => {
        summary.scenarios += 1;
        for (const flavor of scenario.flavors) summary.flavors[flavor] = (summary.flavors[flavor] ?? 0) + 1;
        const byName = { reference: results.reference[i], ts: results.ts[i], py: results.py[i] };
        const ref = byName.reference;
        summary.outcomes[ref.ok ? (ref.rows.length ? 'rows' : 'empty') : 'error'] += 1;
        const sig = signature(byName);
        if (!sig) return;
        const entry = (summary.signatures[sig] ??= { count: 0, seeds: [], candidates: [] });
        entry.count += 1;
        if (entry.seeds.length < 25) entry.seeds.push(scenario.seed);
        failures.push({ scenario, sig });
      });
      console.log(`  ${Math.min(offset + batchSize, seeds.length)}/${seeds.length} scenarios, ${failures.length} disagreeing`);
    }

    // Minimize a few scenarios per distinct signature.
    for (const [sig, entry] of Object.entries(summary.signatures)) {
      const picks = failures.filter(f => f.sig === sig).slice(0, perSignature);
      for (const { scenario } of picks) {
        console.log(`minimizing seed ${scenario.seed}: ${sig}`);
        const reduced = await minimize(impls, scenario.input, { allowWireInvalid: !scenario.wireValid });
        const candidate = candidateCase(scenario.seed, scenario.flavors, reduced.input, reduced.results, reduced.steps, sig);
        const schemaProblems = validateCase(candidate.case);
        if (schemaProblems.length) candidate.case_schema_problems = schemaProblems;
        candidate.seed = scenario.seed;
        candidate.flavors = scenario.flavors;
        candidate.signature = sig;
        candidate.versions = versions;
        const file = path.join(outDir, 'candidates', `candidate-${scenario.seed}.json`);
        fs.writeFileSync(file, `${JSON.stringify(candidate, null, 2)}\n`);
        entry.candidates.push(path.relative(outDir, file));
        summary.candidates.push(path.relative(outDir, file));
        console.log(`  -> ${file} (${reduced.steps.length} reductions)`);
      }
    }
  } finally {
    impls.close();
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = [
    `## Reporting-subscription coverage: differential run`,
    '',
    `@adcp/sdk ${versions.ts} · adcp ${versions.py} · tzdata ${versions.tzdata} · seeds ${seeds[0]}..${seeds[seeds.length - 1]}`,
    '',
    `| Scenarios | With owed rows | Empty | Input errors | Disagreeing |`,
    `|---|---|---|---|---|`,
    `| ${summary.scenarios} | ${summary.outcomes.rows} | ${summary.outcomes.empty} | ${summary.outcomes.error} | ${failures.length} |`,
    '',
  ];
  if (summary.vectors) lines.push(`vectors.json: ${summary.vectors.cases} cases, ${summary.vectors.disagreements.length} disagreeing.`, '');
  if (Object.keys(summary.signatures).length) {
    lines.push('| Disagreement (groups that agree, with their outcome) | Scenarios | Example seeds | Candidates |', '|---|---|---|---|');
    for (const [sig, entry] of Object.entries(summary.signatures)) {
      lines.push(`| \`${sig}\` | ${entry.count} | ${entry.seeds.slice(0, 5).join(', ')} | ${entry.candidates.join(', ')} |`);
    }
  } else {
    lines.push('No disagreements.');
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  const vectorFailures = summary.vectors?.disagreements.length ?? 0;
  process.exitCode = failures.length || vectorFailures ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 2;
});
