#!/usr/bin/env node
/**
 * Guard the manual storyboard runner's released-bundle path: when a run pins
 * `adcpVersion`, it must also pass the matching schema root if one is configured.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const RUNNER_FILE = path.join(__dirname, '..', 'server', 'tests', 'manual', 'run-storyboards.ts');
const THREE_ZERO_COMPAT_WRAPPER = path.join(__dirname, '..', 'scripts', 'run-storyboards-3-0-compat.sh');

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`No matching brace found at offset ${openIndex}`);
}

function runStoryboardOptionBlocks(source) {
  const blocks = [];
  let cursor = 0;
  while (true) {
    const callIndex = source.indexOf('runStoryboard(', cursor);
    if (callIndex === -1) return blocks;
    const optionStart = source.indexOf('{', callIndex);
    if (optionStart === -1) return blocks;
    const optionEnd = findMatchingBrace(source, optionStart);
    blocks.push(source.slice(optionStart, optionEnd + 1));
    cursor = optionEnd + 1;
  }
}

test('released storyboard runs forward schemaRoot with adcpVersion', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  const releasedBlocks = runStoryboardOptionBlocks(source)
    .filter((block) => block.includes('adcpVersion: releasedComplianceVersion'));

  assert.equal(releasedBlocks.length, 2, 'expected both released-version runStoryboard call sites');

  for (const block of releasedBlocks) {
    assert.match(
      block,
      /complianceOptions\?\.schemaRoot[\s\S]*schemaRoot:\s*complianceOptions\.schemaRoot/,
      'runStoryboard calls that pin adcpVersion must also forward complianceOptions.schemaRoot',
    );
  }
});

test('candidate-bundle capability discovery registers the external schema root', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  assert.match(source, /import \{[\s\S]*withExternalSchemaRoot,[\s\S]*\} from '@adcp\/sdk\/testing'/);
  assert.match(
    source,
    /const discovery = complianceOptions\.schemaRoot && releasedComplianceVersion[\s\S]*await withExternalSchemaRoot\([\s\S]*releasedComplianceVersion,[\s\S]*complianceOptions\.schemaRoot,[\s\S]*discover/,
    'Version Packages candidates must be discoverable through their generated external schema root',
  );
});

test('candidate-version compatibility is explicit and resolver-scoped', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  assert.match(
    source,
    /const candidateVersionMode = process\.env\.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE === '1'/,
  );
  assert.match(
    source,
    /candidateVersionMode[\s\S]*isCurrentSourceRun[\s\S]*releasedComplianceVersion[\s\S]*packageVersion !== releasedComplianceVersion/,
    'candidate mode must be limited to the generated current bundle matching package.json',
  );
  assert.match(
    source,
    /resolveStoryboardsForCapabilities\([\s\S]*hostedStableLineAlias:\s*TRAINING_AGENT_CURRENT_ADCP_VERSION/,
  );
  assert.doesNotMatch(
    source,
    /supported_versions:\s*\[[^\]]*releasedComplianceVersion/,
    'candidate mode must not rewrite the seller capability declaration',
  );
});

test('3.0 compatibility wrapper overrides inherited candidate mode', () => {
  const source = fs.readFileSync(THREE_ZERO_COMPAT_WRAPPER, 'utf8');
  assert.match(
    source,
    /ADCP_STORYBOARD_CANDIDATE_VERSION_MODE=0\s+exec bash .*run-storyboards-matrix\.sh" --latest-3\.0/,
    'immutable 3.0 runs must override a candidate-mode environment inherited from current validation',
  );
});

test('storyboard runs use public roots and pin the intended wire surface', () => {
  const source = fs.readFileSync(RUNNER_FILE, 'utf8');
  assert.match(source, /import \{ TRAINING_AGENT_CURRENT_ADCP_VERSION \} from/);
  assert.match(source, /process\.env\.ADCP_COMPLIANCE_DIR[\s\S]*complianceDir:/);
  assert.match(source, /process\.env\.ADCP_SCHEMA_ROOT[\s\S]*schemaRoot:/);
  assert.doesNotMatch(source, /node_modules[\s\S]*@adcp[\s\S]*sdk/);
  assert.doesNotMatch(source, /schemas-data/);
  assert.match(source, /const wireAdcpVersion = isThreeZeroCompatRun[\s\S]*\? '3\.0'[\s\S]*isCurrentSourceRun[\s\S]*\? TRAINING_AGENT_CURRENT_ADCP_VERSION[\s\S]*: undefined/);
  assert.equal(
    (source.match(/\.\.\.\(wireAdcpVersion && \{ wireAdcpVersion \}\)/g) ?? []).length,
    3,
    'expected discovery and both storyboard execution paths to forward wireAdcpVersion',
  );

  for (const block of runStoryboardOptionBlocks(source)) {
    if (!block.includes('adcpVersion: releasedComplianceVersion')) continue;
    assert.match(block, /wireAdcpVersion/);
  }
});
