// An extension's rules, next to its schema.
//
// An extension package has five parts:
//   1. schema.json             the fields (JSON Schema; core types by absolute $ref)
//   2. spec.md                 the normative rules, RFC 2119 keywords, one id per rule
//   3. x-adcp-validation       declarative verifier_constraints inside schema.json, where possible
//   4. conformance/*.yaml      storyboards: steps with expected outcomes, citing rule ids
//   5. index.mjs check()       non-normative reference code
// The build hashes 2, 4, and 5 into the manifest (`docs.spec`, `docs.conformance[]`,
// `docs.reference_code`), so the extension digest pins the exact rules and the exact code
// a buyer runs as well as the fields. The client's module loader refuses an index.mjs that
// does not hash to docs.reference_code (lib/buyer-validator.mjs loadModule). This module
// parses and lints spec.md and finds the files to hash; build-extensions.mjs,
// run-conformance.mjs, and render-extension-docs.mjs share it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

export const SPEC_FILE = 'spec.md';
export const CONFORMANCE_DIR = 'conformance';
export const REFERENCE_CODE_FILE = 'index.mjs';

export const sha256Of = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** The documents a package carries, with their bytes: spec.md first, then conformance/*.yaml|json by name. */
export function docFiles(dir) {
  if (!existsSync(path.join(dir, SPEC_FILE))) throw new Error(`${path.basename(dir)}: no ${SPEC_FILE}; an extension carries its rules, not only its schema`);
  const files = [{ path: SPEC_FILE, bytes: readFileSync(path.join(dir, SPEC_FILE)) }];
  const cdir = path.join(dir, CONFORMANCE_DIR);
  if (existsSync(cdir)) {
    for (const f of readdirSync(cdir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort()) {
      files.push({ path: `${CONFORMANCE_DIR}/${f}`, bytes: readFileSync(path.join(cdir, f)) });
    }
  }
  return files;
}

/** The package's reference code (the module a buyer SDK runs as check()), with its bytes. */
export function referenceCodeFile(dir) {
  const file = path.join(dir, REFERENCE_CODE_FILE);
  if (!existsSync(file)) throw new Error(`${path.basename(dir)}: no ${REFERENCE_CODE_FILE}; an extension package ships the code its digest pins`);
  return { path: REFERENCE_CODE_FILE, bytes: readFileSync(file) };
}

/** The manifest's `docs` block: relative paths plus sha256 of the exact bytes. */
export function docsManifest(files, code) {
  const [spec, ...conformance] = files;
  return {
    spec: { path: spec.path, sha256: sha256Of(spec.bytes) },
    conformance: conformance.map((f) => ({ path: f.path, sha256: sha256Of(f.bytes) })),
    ...(code ? { reference_code: { path: code.path, sha256: sha256Of(code.bytes) } } : {}),
  };
}

export const parseStoryboard = (bytes, file) => (file.endsWith('.json') ? JSON.parse(bytes) : yaml.load(bytes.toString('utf8')));

// ---- spec.md -------------------------------------------------------------

const RULE_HEADING = /^#### ([A-Z]+-R\d+): (.+)$/;
const ENFORCED_BY = /^Enforced by: (.+)$/;
const STRONG = /\b(MUST(?: NOT)?|SHALL(?: NOT)?|REQUIRED)\b/;
const SHOULD = /\b(SHOULD(?: NOT)?|RECOMMENDED)\b/;
const MAY = /\b(MAY|OPTIONAL)\b/;
const CONSTRAINT_REF = /x-adcp-validation `([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)`/g;

/** Text with fenced blocks, code spans, and quoted keywords ("MUST") removed, for keyword scans. */
const prose = (s) => s.replace(/`[^`]*`/g, '').replace(/"(MUST|MUST NOT|SHALL|SHALL NOT|SHOULD|SHOULD NOT|REQUIRED|RECOMMENDED|MAY|OPTIONAL|NOT)"/g, '');

/**
 * spec.md -> { title, rules[] }. A rule is a level-4 heading `#### <ID>: <title>`, its body
 * (one or more paragraphs with RFC 2119 keywords), and an `Enforced by: ...` line.
 */
export function parseSpec(text) {
  const lines = text.split('\n');
  const title = (lines.find((l) => l.startsWith('# ')) ?? '# (untitled)').slice(2).trim();
  const rules = [];
  const outside = []; // [lineNo, text] of prose that is not inside a rule
  let rule = null;
  let fenced = false;
  let section = null;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) fenced = !fenced;
    const m = !fenced && line.match(RULE_HEADING);
    if (m) {
      rule = { id: m[1], title: m[2].trim(), section, body: [], enforcement: [], line: i + 1 };
      rules.push(rule);
      return;
    }
    if (!fenced && /^#{1,4} /.test(line)) {
      rule = null;
      if (/^### /.test(line)) section = line.slice(4).trim();
      return;
    }
    if (rule) {
      const e = !fenced && line.match(ENFORCED_BY);
      if (e) rule.enforcement = e[1].split(';').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
      else rule.body.push(line);
    } else if (!fenced) outside.push([i + 1, line]);
  });
  for (const r of rules) {
    r.text = r.body.join('\n').trim();
    const p = prose(r.text);
    r.level = STRONG.test(p) ? 'MUST' : SHOULD.test(p) ? 'SHOULD' : MAY.test(p) ? 'MAY' : null;
    r.conformanceOnly = r.enforcement.some((e) => /^conformance only\b/i.test(e));
    r.constraints = [...r.enforcement.join(' ').matchAll(CONSTRAINT_REF)].map((x) => `${x[1]}.${x[2]}`);
    delete r.body;
  }
  return { title, rules, outside };
}

/** Every `x-adcp-validation` constraint in a schema, as `group.key` (unique_by counts as a key of its group). */
export function constraintKeys(schema) {
  const keys = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const v = n['x-adcp-validation'];
    if (v) {
      for (const [group, body] of Object.entries(v.verifier_constraints ?? {})) {
        for (const key of Object.keys(body)) if (key !== 'on_violation') keys.add(`${group}.${key}`);
        if (v.unique_by) keys.add(`${group}.unique_by`);
      }
    }
    Object.values(n).forEach(walk);
  };
  walk(schema);
  return keys;
}

/**
 * Problems with a spec and the suite that cites it:
 *  - a normative keyword (MUST, SHOULD, ...) outside a rule: every requirement has an id;
 *  - a rule without a keyword or without an `Enforced by` line, or a duplicate id;
 *  - a rule that cites a constraint the schema does not declare, or a constraint no rule cites;
 *  - a storyboard step that cites an id the spec does not define.
 */
export function lintSpec(spec, { schema, storyboards = [], name = 'spec' }) {
  const problems = [];
  for (const [n, line] of spec.outside) {
    const k = prose(line).match(STRONG) ?? prose(line).match(SHOULD);
    if (k) problems.push(`${name}:${n}: "${k[0]}" outside a rule; give the requirement an id (#### XX-Rn: ...)`);
  }
  const seen = new Set();
  for (const r of spec.rules) {
    if (seen.has(r.id)) problems.push(`${name}:${r.line}: duplicate rule id ${r.id}`);
    seen.add(r.id);
    if (!r.level) problems.push(`${name}:${r.line}: ${r.id} has no RFC 2119 keyword`);
    if (!r.enforcement.length) problems.push(`${name}:${r.line}: ${r.id} has no "Enforced by:" line`);
  }
  if (schema) {
    const declared = constraintKeys(schema);
    const cited = new Set(spec.rules.flatMap((r) => r.constraints));
    for (const c of cited) if (!declared.has(c)) problems.push(`${name}: a rule cites x-adcp-validation ${c}, which the schema does not declare`);
    for (const c of declared) if (!cited.has(c)) problems.push(`${name}: x-adcp-validation ${c} is not cited by any rule`);
  }
  for (const { file, doc } of storyboards) {
    for (const phase of doc.phases ?? []) {
      for (const step of phase.steps ?? []) {
        for (const id of step.covers ?? []) if (!seen.has(id)) problems.push(`${file}: step ${step.id} cites ${id}, which ${name} does not define`);
      }
    }
  }
  return problems;
}
