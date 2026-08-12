#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/run-test-stage-shard.mjs --shard <index>/<total> [--exclude <script-name>]',
  );
  process.exit(2);
}

let shard;
const excluded = new Set();

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--shard') {
    shard = process.argv[index + 1];
    index += 1;
  } else if (argument === '--exclude') {
    const scriptName = process.argv[index + 1];
    if (!scriptName) usage('--exclude requires a script name');
    excluded.add(scriptName);
    index += 1;
  } else {
    usage(`Unknown argument: ${argument}`);
  }
}

const shardMatch = /^(\d+)\/(\d+)$/.exec(shard ?? '');
if (!shardMatch) usage('--shard must use the form <index>/<total>');

const shardIndex = Number(shardMatch[1]);
const shardTotal = Number(shardMatch[2]);
if (shardIndex < 1 || shardTotal < 1 || shardIndex > shardTotal) {
  usage('Shard index must be between 1 and the total number of shards');
}

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const testCommand = packageJson.scripts?.test;
if (typeof testCommand !== 'string') {
  throw new Error('package.json does not define scripts.test');
}

// The root test script is the manifest. Refuse to silently ignore a clause if
// its shape changes; CI should fail until this runner learns how to execute it.
const stages = testCommand.split(/\s+&&\s+/).map((command, index) => {
  const match = /^npm run ([^\s]+)$/.exec(command.trim());
  if (!match) {
    throw new Error(
      `Unsupported clause ${index + 1} in scripts.test: ${JSON.stringify(command)}`,
    );
  }
  return { command: command.trim(), scriptName: match[1] };
});

for (const scriptName of excluded) {
  if (!stages.some((stage) => stage.scriptName === scriptName)) {
    throw new Error(`Excluded script is not a stage in scripts.test: ${scriptName}`);
  }
}

const runnableStages = stages.filter((stage) => !excluded.has(stage.scriptName));
const selectedStages = runnableStages.filter(
  (_stage, index) => index % shardTotal === shardIndex - 1,
);

console.log(
  `Running canonical test shard ${shardIndex}/${shardTotal}: ${selectedStages.length} of ${runnableStages.length} stages`,
);

for (const [index, stage] of selectedStages.entries()) {
  console.log(`\n[${index + 1}/${selectedStages.length}] ${stage.command}`);
  const result = spawnSync('npm', ['run', stage.scriptName], {
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`${stage.command} terminated by signal ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
