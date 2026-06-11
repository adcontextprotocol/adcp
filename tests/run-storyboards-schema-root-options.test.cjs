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
