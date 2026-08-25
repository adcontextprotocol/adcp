#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_VECTOR_SOURCE = path.join(ROOT, 'static', 'compliance', 'source', 'test-vectors');
const DEFAULT_VECTOR_INDEX = path.join(ROOT, 'docs', 'reference', 'test-vectors', 'index.mdx');
const DEFAULT_GUIDANCE = [
  'docs/reference/known-limitations.mdx',
  'docs/reference/whats-new-in-v3.mdx',
  'docs/reference/whats-new-in-3-1.mdx',
  'docs/building/verification/conformance.mdx',
  'docs/protocol/get_adcp_capabilities.mdx',
];

const STALE_CLAIMS = [
  {
    pattern: /\b\d+\s*(?:of|\/)\s*\d+\s+(?:applicable\s+)?storyboards\b/i,
    message: 'hand-authored storyboard totals go stale; link to the latest training-agent CI run instead',
  },
  {
    pattern: /(?:adcontextprotocol\/adcp#|\/issues\/)2383\b/i,
    message: '#2383 is closed; task-level request/response vectors are intentionally covered by storyboards and schemas',
  },
  {
    pattern: /(?:adcp-client#|\/issues\/)2244\b/i,
    message: 'adcp-client#2244 is closed; current runners grade undeclared capability slots as not_applicable',
  },
  {
    pattern: /formal[^.\n]*\blaunch(?:es|ing)\b[^.\n]*\b3\.1\b/i,
    message: 'do not publish the historical 3.1 launch plan as current guidance',
  },
];

function vectorSetNames(sourceDir = DEFAULT_VECTOR_SOURCE) {
  return fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.schema.json')))
    .map(entry => entry.isDirectory() ? entry.name : entry.name.replace(/\.json$/, ''))
    .sort();
}

function lint({
  root = ROOT,
  vectorSource = DEFAULT_VECTOR_SOURCE,
  vectorIndex = DEFAULT_VECTOR_INDEX,
  guidance = DEFAULT_GUIDANCE,
} = {}) {
  const errors = [];
  const catalog = fs.readFileSync(vectorIndex, 'utf8');
  const sets = vectorSetNames(vectorSource);
  const catalogSets = new Set(
    [...catalog.matchAll(/test-vectors\/([a-z0-9][a-z0-9._-]*)(?=\/|[\s)`])/gi)]
      .map(match => match[1].replace(/\.json$/i, '')),
  );

  for (const set of sets) {
    if (!catalogSets.has(set)) {
      errors.push(`${path.relative(root, vectorIndex)}: missing published versioned vector set \`${set}\``);
    }
  }

  for (const relativePath of guidance) {
    const file = path.resolve(root, relativePath);
    const markdown = fs.readFileSync(file, 'utf8');
    for (const claim of STALE_CLAIMS) {
      if (claim.pattern.test(markdown)) {
        errors.push(`${path.relative(root, file)}: ${claim.message}`);
      }
    }
  }

  return { errors, vectorSets: sets };
}

function main() {
  const result = lint();
  console.log(`conformance documentation freshness: ${result.vectorSets.length} versioned vector set(s)`);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log('✓ vector catalog is complete and current guidance contains no stale conformance status claims.');
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`conformance documentation freshness lint failed: ${error.message}`);
    process.exit(2);
  }
}

module.exports = { lint, vectorSetNames };
