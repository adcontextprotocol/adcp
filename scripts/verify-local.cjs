#!/usr/bin/env node
'use strict';
// On-demand local verification, outside the commit hooks (.husky/pre-commit,
// .husky/pre-push); CI runs every suite and is the gate. Run it to check the
// tests your change affects, or the full suites, without committing:
//
//   npm run verify:local                  tests affected since origin/main, then typecheck
//   npm run verify:local -- --since HEAD~1
//   npm run verify:local -- --full        the full root and server unit suites
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const options = { since: 'origin/main', full: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--full') options.full = true;
    else if (argv[i] === '--since' && argv[i + 1]) options.since = argv[++i];
    else throw new Error(`Unknown argument ${argv[i]}. Use --since <ref> or --full.`);
  }
  return options;
}

function run(label, command, args) {
  console.log(`\n▶ ${label}: ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`✖ ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { since, full } = options;
  if (full) {
    run('Root unit tests', 'npm', ['run', 'test:unit']);
    run('Server unit tests', 'node', ['scripts/precommit-server-unit.cjs', '--full']);
  } else {
    // vitest follows the import graph from the files changed since the ref.
    run('Affected root tests', 'npx', ['vitest', 'run', '--dir', 'tests/', '--pool=threads', '--changed', since, '--passWithNoTests']);
    run('Affected server tests', 'npx', ['vitest', 'run', '--config', 'server/vitest.config.ts', '--changed', since, '--passWithNoTests']);
  }
  run('Typecheck', 'npm', ['run', 'typecheck']);
  console.log('\n✅ Local verification passed. CI still runs every suite.');
}

main();
