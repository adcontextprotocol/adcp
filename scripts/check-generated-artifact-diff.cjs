#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Usage: node scripts/check-generated-artifact-diff.cjs <path> [path...]');
  process.exit(2);
}

function git(args, opts = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

const root = git(['rev-parse', '--show-toplevel']).trim();

function changedFiles(args) {
  const out = git(args);
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

const files = new Set([
  ...changedFiles(['diff', '--name-only', '--', ...paths]),
  ...changedFiles(['diff', '--cached', '--name-only', '--', ...paths]),
]);

const GENERATED_KEYS = new Set(['generated_at', 'generatedAt', '_generatedAt']);

function stripGeneratedMetadata(value) {
  if (Array.isArray(value)) return value.map(stripGeneratedMetadata);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (GENERATED_KEYS.has(key)) continue;
    copy[key] = stripGeneratedMetadata(child);
  }
  return copy;
}

function normalize(file, content) {
  if (file.endsWith('.json')) {
    return JSON.stringify(stripGeneratedMetadata(JSON.parse(content)), null, 2) + '\n';
  }
  return content;
}

function readHead(file) {
  const result = spawnSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout;
}

const realDiffs = [];
for (const file of files) {
  const abs = path.join(root, file);
  const head = readHead(file);
  const working = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (head === null || working === null) {
    realDiffs.push(file);
    continue;
  }
  try {
    if (normalize(file, head) !== normalize(file, working)) {
      realDiffs.push(file);
    }
  } catch {
    if (head !== working) realDiffs.push(file);
  }
}

if (realDiffs.length > 0) {
  console.error('Generated artifacts are stale:');
  for (const file of realDiffs) console.error(`  - ${file}`);
  process.exit(1);
}

console.log('Generated artifact diff check passed.');
