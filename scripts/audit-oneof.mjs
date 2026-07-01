#!/usr/bin/env node
// Walks every JSON schema under static/schemas/source/ and classifies each
// `oneOf` as discriminated / structurally narrowable / dangerous / scalar.
// Tracking issue: https://github.com/adcontextprotocol/adcp/issues/3917
//
// Modes:
//   node scripts/audit-oneof.mjs                       # print human report to stdout
//   node scripts/audit-oneof.mjs --json                # print full row data as JSON
//   node scripts/audit-oneof.mjs --file <path>         # restrict to one schema file (relative to static/schemas/source)
//   node scripts/audit-oneof.mjs --check               # diff against baseline; exit 1 on regression
//   node scripts/audit-oneof.mjs --update              # rewrite baseline (refuses to add new undiscriminated entries)
//   node scripts/audit-oneof.mjs --update --accept-new # required to ratchet in NEW dangerous/narrowable entries
//
// Baseline lives at scripts/oneof-discriminators.baseline.json. The check
// mode fails CI if (a) any new dangerous/narrowable oneOf appears that is
// not already in the baseline, or (b) any baseline entry has regressed to
// a worse status. Improvements (dangerous → discriminated) are accepted
// silently but printed in the diff so they get reflected on --update.
//
// Known limitations: ref resolution is one hop; variants of the form
// {allOf: [{$ref: ...}, {required: [...]}]} are not fused before classification
// (they fall into `dangerous` and need the discriminator added at the parent).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_ROOT = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const BASELINE_PATH = path.join(__dirname, 'oneof-discriminators.baseline.json');

const STATUS_RANK = { discriminated: 0, scalar: 0, narrowable: 1, dangerous: 2 };

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

const schemaCache = new Map();
function loadSchema(absPath) {
  if (schemaCache.has(absPath)) return schemaCache.get(absPath);
  try {
    const content = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    schemaCache.set(absPath, content);
    return content;
  } catch {
    schemaCache.set(absPath, null);
    return null;
  }
}

// Refs in this repo: /schemas/v1/path/to/file.json#/... | ../foo.json#/... | #/...
function resolveRef(ref, sourceFile) {
  if (!ref || typeof ref !== 'string') return null;
  const [filePart, fragment] = ref.split('#');
  let targetFile = sourceFile;
  if (filePart) {
    if (filePart.startsWith('/schemas/v1/')) {
      targetFile = path.join(SCHEMA_ROOT, filePart.replace(/^\/schemas\/v1\//, ''));
    } else if (filePart.startsWith('/schemas/')) {
      targetFile = path.join(SCHEMA_ROOT, filePart.replace(/^\/schemas\//, ''));
    } else if (filePart.startsWith('/')) {
      targetFile = path.join(SCHEMA_ROOT, filePart.replace(/^\//, ''));
    } else {
      targetFile = path.resolve(path.dirname(sourceFile), filePart);
    }
  }
  // Containment guard — refuse to follow refs that escape the schema tree.
  const normalized = path.resolve(targetFile);
  if (normalized !== SCHEMA_ROOT && !normalized.startsWith(SCHEMA_ROOT + path.sep)) {
    return null;
  }
  targetFile = normalized;
  const schema = loadSchema(targetFile);
  if (!schema) return null;
  if (!fragment || fragment === '/') return { schema, file: targetFile };
  const parts = fragment
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
  let node = schema;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else return null;
  }
  return { schema: node, file: targetFile };
}

// One-hop ref resolution; deeper graphs return refOnly so the row is conservative.
function variantInfo(variant, sourceFile) {
  if (!variant || typeof variant !== 'object') {
    return { properties: {}, required: [], refOnly: false, scalar: false };
  }
  const isPureScalar =
    typeof variant.type === 'string' &&
    variant.type !== 'object' &&
    !variant.properties &&
    !variant.$ref &&
    !variant.oneOf &&
    !variant.anyOf &&
    !variant.allOf;
  if (isPureScalar) {
    return { properties: {}, required: [], refOnly: false, scalar: true, scalarType: variant.type };
  }
  if (variant.const !== undefined || variant.enum !== undefined) {
    return { properties: {}, required: [], refOnly: false, scalar: true, scalarType: 'enum/const' };
  }
  if (variant.$ref) {
    const resolved = resolveRef(variant.$ref, sourceFile);
    if (!resolved) return { properties: {}, required: [], refOnly: true, scalar: false, ref: variant.$ref };
    const target = resolved.schema;
    if (target && (target.oneOf || target.anyOf)) {
      return {
        properties: target.properties || {},
        required: target.required || [],
        refOnly: 'nested-union',
        ref: variant.$ref,
      };
    }
    return {
      properties: target.properties || {},
      required: target.required || [],
      refOnly: !target.properties,
      scalar: false,
      ref: variant.$ref,
    };
  }
  return {
    properties: variant.properties || {},
    required: variant.required || [],
    refOnly: false,
    scalar: false,
  };
}

function classify(oneOfArr, parentSchema, sourceFile) {
  const variants = oneOfArr.map((v) => ({ raw: v, info: variantInfo(v, sourceFile) }));
  if (variants.every((v) => v.info.scalar)) {
    return { kind: 'scalar', variants, note: variants.map((v) => v.info.scalarType).join('|') };
  }

  if (parentSchema && parentSchema.discriminator && parentSchema.discriminator.propertyName) {
    const key = parentSchema.discriminator.propertyName;
    // Enforce that every variant actually declares `properties.<key>` as a const
    // (or single-element enum) and lists it in `required`, with distinct values
    // across variants. Otherwise the discriminator hint is unbacked — exactly
    // the two-sources-of-truth failure mode we want to prevent.
    // Trust nested-union and pure-ref variants — their target may carry the
    // const further down. We only catch the failure mode where a non-ref
    // variant declares no const for the discriminator key, OR a const
    // collides with another variant (the two-sources-of-truth drift).
    const seen = new Set();
    const violations = [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (v.info.refOnly === 'nested-union' || v.info.refOnly === true) continue;
      const prop = (v.info.properties || {})[key];
      const constVal = prop && prop.const !== undefined ? prop.const : Array.isArray(prop?.enum) && prop.enum.length === 1 ? prop.enum[0] : undefined;
      const isRequired = (v.info.required || []).includes(key);
      if (constVal === undefined || !isRequired) {
        violations.push(`${i}:missing const+required for "${key}"`);
        continue;
      }
      const k = JSON.stringify(constVal);
      if (seen.has(k)) violations.push(`${i}:duplicate "${key}" value ${k}`);
      seen.add(k);
    }
    if (violations.length) {
      return {
        kind: 'dangerous',
        variants,
        note: `discriminator.propertyName="${key}" is set but unbacked: ${violations.join(' | ')}`,
      };
    }
    return {
      kind: 'discriminated',
      discriminator: parentSchema.discriminator.propertyName,
      variants,
      note: `discriminator.propertyName=${parentSchema.discriminator.propertyName}`,
    };
  }

  // const-property discriminator: every variant has the same required key whose const values are distinct
  const constKeysPerVariant = variants.map((v) => {
    const keys = [];
    for (const [k, p] of Object.entries(v.info.properties || {})) {
      if (p && (p.const !== undefined || (Array.isArray(p.enum) && p.enum.length === 1))) keys.push(k);
    }
    return new Set(keys);
  });
  if (constKeysPerVariant.every((s) => s.size > 0)) {
    const intersect = [...constKeysPerVariant[0]].filter((k) => constKeysPerVariant.every((s) => s.has(k)));
    for (const k of intersect) {
      const vals = variants.map((v) => {
        const p = v.info.properties[k];
        return p.const !== undefined ? JSON.stringify(p.const) : JSON.stringify(p.enum[0]);
      });
      const distinct = new Set(vals).size === vals.length;
      const requiredByAll = variants.every((v) => (v.info.required || []).includes(k));
      if (distinct && requiredByAll) {
        return {
          kind: 'discriminated',
          discriminator: k,
          variants,
          note: `const-property "${k}" with values [${vals.join(', ')}]`,
        };
      }
    }
  }

  // structural narrowability: each variant has at least one required key not required by any other variant
  const reqSets = variants.map((v) => new Set(v.info.required || []));
  const uniquePerVariant = reqSets.map((s, i) => {
    const others = reqSets.filter((_, j) => j !== i);
    return [...s].filter((r) => !others.some((o) => o.has(r)));
  });
  if (uniquePerVariant.every((arr) => arr.length > 0)) {
    return {
      kind: 'narrowable',
      variants,
      uniquePerVariant,
      note: variants.map((v, i) => `${i}:[${uniquePerVariant[i].join(',')}]`).join(' | '),
    };
  }

  // overlap — dangerous
  const intersectReq = reqSets.length ? [...reqSets[0]].filter((r) => reqSets.every((s) => s.has(r))) : [];
  const summary = variants
    .map((v, i) => {
      if (v.info.refOnly === 'nested-union') return `${i}:nested-union(${v.info.ref})`;
      if (v.info.refOnly === true) return `${i}:ref-only(${v.info.ref})`;
      if (v.info.scalar) return `${i}:${v.info.scalarType}`;
      return `${i}:req=[${(v.info.required || []).join(',') || '∅'}]`;
    })
    .join(' | ');
  return { kind: 'dangerous', variants, note: `shared-required=[${intersectReq.join(',') || '∅'}]; ${summary}` };
}

function pointerEscape(seg) {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

function walk(node, ptr, sourceFile, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, ptr + '/' + i, sourceFile, out));
    return;
  }
  if (Array.isArray(node.oneOf)) {
    out.push({ pointer: ptr + '/oneOf', arr: node.oneOf, parent: node, sourceFile });
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref') continue;
    walk(v, ptr + '/' + pointerEscape(k), sourceFile, out);
  }
}

function audit({ fileFilter } = {}) {
  let files = walkFiles(SCHEMA_ROOT);
  if (fileFilter) {
    const target = path.resolve(SCHEMA_ROOT, fileFilter);
    files = files.filter((f) => path.resolve(f) === target);
    if (!files.length) {
      process.stderr.write(`No schema file matched --file ${fileFilter} (resolved to ${target}).\n`);
      process.exit(2);
    }
  }
  const all = [];
  for (const f of files) {
    const schema = loadSchema(f);
    if (!schema) continue;
    walk(schema, '#', f, all);
  }
  const rows = all.map((oo) => {
    const c = classify(oo.arr, oo.parent, oo.sourceFile);
    return {
      file: path.relative(SCHEMA_ROOT, oo.sourceFile).split(path.sep).join('/'),
      pointer: oo.pointer,
      variants: oo.arr.length,
      kind: c.kind,
      note: c.note,
      discriminator: c.discriminator,
    };
  });
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.pointer.localeCompare(b.pointer));
  return { fileCount: files.length, rows };
}

function rowKey(r) {
  return `${r.file}#${r.pointer}`;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { entries: {} };
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(rows) {
  const entries = {};
  for (const r of rows) {
    if (r.kind === 'discriminated' || r.kind === 'scalar') continue;
    entries[rowKey(r)] = { kind: r.kind, variants: r.variants, note: r.note };
  }
  const sortedKeys = Object.keys(entries).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = entries[k];
  const payload = {
    description:
      'Snapshot of every `oneOf` in static/schemas/source/ that is not yet discriminated. Generated by scripts/audit-oneof.mjs. Tracking: adcontextprotocol/adcp#3917. Run `node scripts/audit-oneof.mjs --update` to refresh after fixing or accepting new entries.',
    entries: sorted,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
}

function diff(rows, baseline) {
  const current = new Map(
    rows.filter((r) => r.kind !== 'discriminated' && r.kind !== 'scalar').map((r) => [rowKey(r), r]),
  );
  const base = new Map(Object.entries(baseline.entries || {}));
  const added = []; // new dangerous/narrowable not in baseline
  const regressed = []; // baseline narrowable → dangerous, or baseline missing key reappeared worse
  const improved = []; // baseline entry that is now discriminated or has improved
  const removed = []; // baseline entry no longer present at all (could be deletion or rename)
  for (const [key, row] of current) {
    const prior = base.get(key);
    if (!prior) {
      added.push(row);
    } else if (STATUS_RANK[row.kind] > STATUS_RANK[prior.kind]) {
      regressed.push({ row, prior });
    } else if (STATUS_RANK[row.kind] < STATUS_RANK[prior.kind]) {
      improved.push({ row, prior });
    }
  }
  for (const [key, prior] of base) {
    if (!current.has(key)) {
      const stillPresent = rows.find((r) => rowKey(r) === key);
      if (stillPresent && (stillPresent.kind === 'discriminated' || stillPresent.kind === 'scalar')) {
        improved.push({ row: stillPresent, prior });
      } else {
        removed.push({ key, prior });
      }
    }
  }
  return { added, regressed, improved, removed };
}

function printReport(result) {
  const { rows, fileCount } = result;
  const counts = { discriminated: 0, narrowable: 0, dangerous: 0, scalar: 0 };
  for (const r of rows) counts[r.kind]++;
  process.stdout.write(`oneOf audit — ${rows.length} occurrences across ${fileCount} schema files\n`);
  process.stdout.write(
    `  ✓ discriminated: ${counts.discriminated}  ⚠ narrowable: ${counts.narrowable}  ✗ dangerous: ${counts.dangerous}  (scalar: ${counts.scalar})\n\n`,
  );
  for (const r of rows) {
    if (r.kind === 'discriminated' || r.kind === 'scalar') continue;
    const mark = r.kind === 'dangerous' ? '✗' : '⚠';
    process.stdout.write(`${mark} ${r.file} ${r.pointer} (${r.variants}) — ${r.note}\n`);
  }
}

const argv = process.argv.slice(2);
const args = new Set(argv);
function getArgValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const fileFilter = getArgValue('--file');

if (args.has('--update')) {
  const result = audit({ fileFilter });
  if (fileFilter) {
    process.stderr.write(`--update with --file is not supported (baseline must reflect the whole tree).\n`);
    process.exit(2);
  }
  const baseline = loadBaseline();
  const d = diff(result.rows, baseline);
  if (d.added.length && !args.has('--accept-new')) {
    process.stderr.write(
      `\nRefusing to add ${d.added.length} NEW undiscriminated oneOf(s) to the baseline. The right fix is almost always to add a discriminator, not to ratchet the baseline. If you genuinely intend to accept these, re-run with \`--update --accept-new\`:\n\n`,
    );
    for (const r of d.added) {
      process.stderr.write(`  ${r.kind === 'dangerous' ? '✗' : '⚠'} ${r.file} ${r.pointer} (${r.variants}) — ${r.note}\n`);
    }
    process.stderr.write(`\nSee https://github.com/adcontextprotocol/adcp/issues/3917 for the patterns to use.\n`);
    process.exit(1);
  }
  writeBaseline(result.rows);
  process.stdout.write(`Baseline written to ${path.relative(REPO_ROOT, BASELINE_PATH)}\n`);
  if (d.added.length) {
    process.stdout.write(`Accepted ${d.added.length} new undiscriminated entr${d.added.length === 1 ? 'y' : 'ies'} (--accept-new). Reviewers should scrutinize this baseline diff.\n`);
  }
  process.exit(0);
}

if (args.has('--check')) {
  const result = audit({ fileFilter });
  const baseline = loadBaseline();
  const d = diff(result.rows, baseline);
  let failed = false;
  if (d.added.length) {
    failed = true;
    process.stderr.write(`\nNew undiscriminated oneOf(s) — add a discriminator or run with --update if accepted:\n`);
    for (const r of d.added) {
      process.stderr.write(`  ${r.kind === 'dangerous' ? '✗' : '⚠'} ${r.file} ${r.pointer} (${r.variants}) — ${r.note}\n`);
    }
  }
  if (d.regressed.length) {
    failed = true;
    process.stderr.write(`\nRegressions (status got worse vs baseline):\n`);
    for (const { row, prior } of d.regressed) {
      process.stderr.write(`  ${row.file} ${row.pointer}: ${prior.kind} → ${row.kind} — ${row.note}\n`);
    }
  }
  if (d.improved.length) {
    process.stdout.write(`\nImprovements (status got better — run with --update to ratchet baseline):\n`);
    for (const { row, prior } of d.improved) {
      process.stdout.write(`  ${row.file} ${row.pointer}: ${prior.kind} → ${row.kind}\n`);
    }
  }
  if (d.removed.length) {
    process.stdout.write(`\nBaseline entries no longer present (file or pointer renamed/deleted):\n`);
    for (const { key } of d.removed) {
      process.stdout.write(`  ${key}\n`);
    }
  }
  if (failed) {
    process.stderr.write(
      `\nSee https://github.com/adcontextprotocol/adcp/issues/3917 for context.\n` +
        `To fix: add a discriminator to the new oneOf. Two patterns work:\n` +
        `  1. Schema-level \`discriminator: { propertyName: "<key>" }\` (see core/assets/asset-union.json).\n` +
        `  2. Per-variant required const property with distinct values (see core/activation-key.json).\n` +
        `To inspect locally: \`npm run audit:oneof\` (or \`node scripts/audit-oneof.mjs --file <path>\` for one file).\n` +
        `If you genuinely intend to accept the new entry: \`node scripts/audit-oneof.mjs --update --accept-new\`.\n`,
    );
    process.exit(1);
  }
  const counts = { discriminated: 0, narrowable: 0, dangerous: 0, scalar: 0 };
  for (const r of result.rows) counts[r.kind]++;
  process.stdout.write(
    `\nok — no new undiscriminated oneOf. Current: ✓ ${counts.discriminated}  ⚠ ${counts.narrowable}  ✗ ${counts.dangerous}  (scalar ${counts.scalar})\n`,
  );
  process.exit(0);
}

if (args.has('--json')) {
  const result = audit({ fileFilter });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

const result = audit({ fileFilter });
printReport(result);
