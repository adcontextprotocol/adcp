#!/usr/bin/env node
/**
 * Keep the request-signing guide's error-code claims aligned with the
 * conformance vectors it tells implementers to satisfy.
 *
 * Scope is intentionally narrow. The broader security guide documents
 * discovery/runtime errors that are not graded by request-signing vectors.
 * This lint checks concrete request-signing taxonomy literals and first-column
 * code-table entries inside request-signing.mdx's "Error codes" section — the
 * exact surface that previously published seven invented, unprefixed codes.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DOC_PATH = path.join(ROOT, 'docs', 'building', 'by-layer', 'L1', 'request-signing.mdx');
const DEFAULT_GRADING_DOC_PATH = path.join(ROOT, 'docs', 'building', 'verification', 'grading.mdx');
const DEFAULT_CONTRACT_ROOT = path.join(
  ROOT,
  'static',
  'compliance',
  'source',
  'test-vectors',
  'request-signing',
);
const CONCRETE_REQUEST_CODE_PATTERN = /\brequest_(?:signature_[a-z0-9_]*[a-z0-9]|target_uri_malformed)\b/g;
const EXACT_REQUEST_CODE_PATTERN = /^request_(?:signature_[a-z0-9_]*[a-z0-9]|target_uri_malformed)$/;
const SNAKE_CASE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function walkJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath);
  }
  return files;
}

function collectContractCodes(contractRoot = DEFAULT_CONTRACT_ROOT) {
  const vectorFiles = walkJsonFiles(contractRoot)
    .filter(file => file.split(path.sep).includes('negative'));

  if (vectorFiles.length === 0) {
    throw new Error(`No request-signing negative vectors found under ${contractRoot}`);
  }

  const codes = new Set();
  for (const file of vectorFiles) {
    let vector;
    try {
      vector = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Could not parse ${file}: ${error.message}`);
    }
    const code = vector && vector.expected_outcome && vector.expected_outcome.error_code;
    if (typeof code !== 'string' || !EXACT_REQUEST_CODE_PATTERN.test(code)) {
      throw new Error(`${file}: negative vector is missing a request-signing expected_outcome.error_code`);
    }
    codes.add(code);
  }
  return codes;
}

function extractErrorCodesSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  const section = [];
  let collecting = false;
  let fenceMarker = null;

  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (fenceMarker === null) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
      if (collecting) section.push(line);
      continue;
    }

    if (fenceMarker === null) {
      if (!collecting && /^### Error codes[ \t]*$/.test(line)) {
        collecting = true;
        continue;
      }
      if (collecting && /^#{1,3}\s+/.test(line)) break;
    }
    if (collecting) section.push(line);
  }

  return collecting ? section.join('\n') : null;
}

function extractDocCodeClaims(markdown) {
  const section = extractErrorCodesSection(markdown);
  if (section === null) return null;
  const codes = new Set(section.match(CONCRETE_REQUEST_CODE_PATTERN) || []);

  // A code taxonomy table puts its machine value in the first column. Limit
  // generic snake_case matching to that structural position so prose such as
  // `brand_json_url` is not mistaken for an error-code claim.
  const tableCodePattern = /^\|\s*`([^`\r\n]+)`\s*\|/gm;
  for (const match of section.matchAll(tableCodePattern)) {
    const candidate = match[1].trim();
    if (SNAKE_CASE_CODE_PATTERN.test(candidate)) codes.add(candidate);
  }
  return codes;
}

function extractFencedBlocks(markdown) {
  const blocks = [];
  const pattern = /^\s*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)^\s*\1\s*$/gm;
  for (const match of markdown.matchAll(pattern)) blocks.push(match[2]);
  return blocks;
}

function extractVerifyVectorCommands(block) {
  return block
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .filter(line => /\bsigning\s+verify-vector\b/.test(line));
}

function lintVerifyVectorGuidance(markdown, displayPath) {
  const errors = [];
  const commands = extractFencedBlocks(markdown).flatMap(extractVerifyVectorCommands);
  if (commands.length === 0) {
    errors.push(`${displayPath}: missing signing verify-vector invocation`);
  }

  for (const command of commands) {
    if (/\bcompliance\/cache\/[^\s`"']+/.test(command)) {
      errors.push(`${displayPath}: verify-vector invocations must not use package-internal compliance/cache paths`);
    }
    if (!/(?:^|\s)--vector(?:\s|=)/m.test(command)) {
      errors.push(`${displayPath}: signing verify-vector invocation must pass --vector`);
    }
    if (!/(?:^|\s)--keys(?:\s|=)/m.test(command)) {
      errors.push(`${displayPath}: signing verify-vector invocation must pass --keys`);
    }
  }

  if (/\b(?:reads?|reading)\s+(?:a\s+)?vector\s+from\s+stdin\b/i.test(markdown)) {
    errors.push(`${displayPath}: signing verify-vector reads local files, not stdin`);
  }
  return errors;
}

function lint({
  root = ROOT,
  docPath = DEFAULT_DOC_PATH,
  gradingDocPath = DEFAULT_GRADING_DOC_PATH,
  contractRoot = DEFAULT_CONTRACT_ROOT,
} = {}) {
  const contractCodes = collectContractCodes(contractRoot);
  const docCodes = extractDocCodeClaims(fs.readFileSync(docPath, 'utf8'));
  const displayPath = path.relative(root, docPath) || docPath;
  const gradingDisplayPath = path.relative(root, gradingDocPath) || gradingDocPath;
  const errors = [];

  errors.push(...lintVerifyVectorGuidance(fs.readFileSync(docPath, 'utf8'), displayPath));
  errors.push(...lintVerifyVectorGuidance(fs.readFileSync(gradingDocPath, 'utf8'), gradingDisplayPath));

  if (docCodes === null) {
    errors.push(`${displayPath}: missing expected "### Error codes" section`);
    return { errors, contractCodes, docCodes: new Set() };
  }

  for (const code of [...docCodes].sort()) {
    if (!contractCodes.has(code)) {
      errors.push(
        `${displayPath}: \`${code}\` is not an expected error code in ` +
        'static/compliance/source/test-vectors/request-signing/**/negative/*.json',
      );
    }
  }

  return { errors, contractCodes, docCodes };
}

function main() {
  const result = lint();
  console.log(
    `doc-compliance drift lint: ${result.docCodes.size} concrete guide claim(s), ` +
    `${result.contractCodes.size} current contract code(s)`,
  );
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log('✓ request-signing documentation matches the current conformance contract.');
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`doc-compliance drift lint failed: ${error.message}`);
    process.exit(2);
  }
}

module.exports = {
  collectContractCodes,
  extractDocCodeClaims,
  extractErrorCodesSection,
  extractFencedBlocks,
  extractVerifyVectorCommands,
  lintVerifyVectorGuidance,
  lint,
};
