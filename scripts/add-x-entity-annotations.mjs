#!/usr/bin/env node
/**
 * Add `x-entity` annotations to identity-bearing fields in AdCP JSON schemas.
 *
 * Reads scripts/x-entity-field-map.json for the field-name → entity-type map.
 * Walks each target file, finds every `"<field>": { ... "type": "string" ... }`
 * block that doesn't already carry `x-entity`, and appends the annotation
 * before the closing brace with a leading comma attached to the preceding
 * value (so the formatting matches hand-authored JSON).
 *
 * Fields tagged `__ambiguous__` or `__scope_specific__` are skipped; those
 * require a per-site decision or a shared-type annotation. Use `--overlay
 * <file>` to layer a scope-specific map on top of the base.
 *
 * Usage:
 *   node scripts/add-x-entity-annotations.mjs <schema>... [--overlay <path>]
 *   node scripts/add-x-entity-annotations.mjs 'static/schemas/source/foo/'*.json
 *
 * Safe to re-run: already-annotated fields are skipped. See
 * docs/contributing/x-entity-annotation.md for the authoring guide.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAP_PATH = path.join(__dirname, 'x-entity-field-map.json');

const AMBIGUOUS_SENTINELS = new Set(['__ambiguous__', '__scope_specific__']);

function loadFieldMap(overlayPath) {
  const base = JSON.parse(fs.readFileSync(DEFAULT_MAP_PATH, 'utf8')).fields || {};
  const merged = { ...base };
  if (overlayPath) {
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')).fields || {};
    Object.assign(merged, overlay);
  }
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => typeof v === 'string' && !AMBIGUOUS_SENTINELS.has(v)),
  );
}

function patchFile(file, fieldEntity) {
  let src = fs.readFileSync(file, 'utf8');
  let touched = 0;
  for (const [field, entity] of Object.entries(fieldEntity)) {
    const header = new RegExp(`"${field}":\\s*\\{`, 'g');
    const insertions = [];
    let m;
    while ((m = header.exec(src)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      let inString = false;
      let escape = false;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (escape) { escape = false; i += 1; continue; }
        if (ch === '\\' && inString) { escape = true; i += 1; continue; }
        if (ch === '"') { inString = !inString; i += 1; continue; }
        if (!inString) {
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
        }
        if (depth === 0) break;
        i += 1;
      }
      if (depth !== 0) continue;
      const body = src.slice(start, i);
      if (!/"type":\s*"string"/.test(body)) continue;
      if (/"x-entity"\s*:/.test(body)) continue;
      // Match the indentation of existing properties in the same block.
      const lines = body.split('\n');
      let indent = '';
      for (let k = lines.length - 1; k >= 0; k -= 1) {
        const match = lines[k].match(/^(\s+)"[^"]+"\s*:/);
        if (match) { indent = match[1]; break; }
      }
      if (!indent) indent = '  ';
      // Insert right after the last non-whitespace char (keeps the trailing
      // comma attached to the preceding value instead of floating alone).
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j -= 1;
      const needsComma = src[j] !== ',' && src[j] !== '{';
      insertions.push({
        at: j + 1,
        text: `${needsComma ? ',' : ''}\n${indent}"x-entity": "${entity}"`,
      });
      touched += 1;
    }
    insertions.sort((a, b) => b.at - a.at);
    for (const ins of insertions) src = src.slice(0, ins.at) + ins.text + src.slice(ins.at);
  }
  if (touched > 0) {
    fs.writeFileSync(file, src);
    console.log(`  ${file}: ${touched}`);
  }
  return touched;
}

function main() {
  const args = process.argv.slice(2);
  let overlayPath = null;
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--overlay' && i + 1 < args.length) {
      overlayPath = args[i + 1];
      i += 1;
    } else {
      files.push(args[i]);
    }
  }
  if (files.length === 0) {
    console.error('usage: node add-x-entity-annotations.mjs <file>... [--overlay <path>]');
    process.exit(1);
  }
  const fieldEntity = loadFieldMap(overlayPath);
  let total = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) { console.warn(`  (missing: ${file})`); continue; }
    total += patchFile(file, fieldEntity);
  }
  console.log(`Done: ${total} annotation(s) across ${files.length} file(s).`);
}

main();
