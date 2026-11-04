#!/usr/bin/env node
/**
 * Replaces inline copies of a named scalar schema with a `$ref` to it (#8525).
 *
 *   npm run schemas:normalize                   list what would change
 *   npm run schemas:normalize -- --write        edit the sites, then run the proof
 *   ... --doc core/x.json --property a,b        also match a new document's
 *                                               weak constraint on these names
 *   ... --doc "core/y.json#/definitions/z"      use a definition in core/y.json
 *   ... --site "core/y.json#/properties/z"      only this site (repeatable)
 *   ... --adopt-annotations                     allow a target whose only
 *                                               difference is annotations
 *
 * To name a new concept, add its titled document under core/ or enums/ and
 * register it in index.json, or add a definitions entry when every site is in
 * one document, then run this with --doc. Sites come from the same rules as
 * scripts/lint-schema-named-constraints.cjs.
 *
 * A site changes only when it has one target and the resolved document stays
 * identical, so a target annotation the site doesn't state blocks the edit
 * unless --adopt-annotations is given. List the target in ANNOTATION_ADOPTIONS
 * in tests/named-schema-extraction.test.cjs when you adopt.
 * Each site is edited in place and keeps its own description and annotations,
 * so there is no whitespace churn. With --write, the script then runs
 * `tests/named-schema-extraction.test.cjs` against HEAD, which resolves every
 * added `$ref` and compares each touched document with the committed one.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const isAnnotation = (key) => ['description', 'title', '$comment', 'examples', 'example', 'default', 'deprecated',
  'readOnly', 'writeOnly', 'enumDescriptions', 'enumMetadata'].includes(key) || key.startsWith('x-');
const {
  collectSites,
  constraintsOf,
  findInlineCopies,
  indexNamedSchemas,
  loadDocuments,
  siteKey,
} = require('./lint-schema-named-constraints.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const DOCUMENT_METADATA = new Set(['$schema', '$id', 'title', 'description']);

/** A JSON parser that records where each object member sits in the text. */
function parseWithPositions(text) {
  let i = 0;
  const skip = () => { while (' \t\r\n'.includes(text[i])) i++; };
  function string() {
    const start = i++;
    while (text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    i++;
    return JSON.parse(text.slice(start, i));
  }
  function value() {
    skip();
    const start = i;
    if (text[i] === '{') {
      i++;
      const members = [];
      skip();
      if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members }; }
      for (;;) {
        skip();
        const memberStart = i;
        const key = string();
        skip();
        i++;
        const child = value();
        members.push({ key, start: memberStart, end: child.end, value: child });
        skip();
        if (text[i++] !== ',') break;
      }
      return { kind: 'object', start, end: i, members };
    }
    if (text[i] === '[') {
      i++;
      const items = [];
      skip();
      if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items }; }
      for (;;) {
        items.push(value());
        skip();
        if (text[i++] !== ',') break;
      }
      return { kind: 'array', start, end: i, items };
    }
    if (text[i] === '"') { string(); return { kind: 'string', start, end: i }; }
    while (i < text.length && !',}] \t\r\n'.includes(text[i])) i++;
    return { kind: 'scalar', start, end: i };
  }
  return value();
}

function locate(root, pointer) {
  let node = root;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node.kind === 'object' ? node.members.find((member) => member.key === key).value : node.items[Number(key)];
  }
  return node;
}

/** Rewrites one object: the first removed key becomes the `$ref`, the others go. */
function rewriteSite(text, node, removeKeys, ref) {
  const remove = new Set(removeKeys);
  const { members } = node;
  const first = members.findIndex((member) => remove.has(member.key));
  const lead = text.slice(node.start + 1, members[0].start);
  const trail = text.slice(members[members.length - 1].end, node.end - 1);
  const kept = [];
  members.forEach((member, index) => {
    if (index === first) kept.push({ index, text: `"$ref": ${JSON.stringify(ref)}` });
    else if (!remove.has(member.key)) kept.push({ index, text: text.slice(member.start, member.end) });
  });
  let out = `{${lead}${kept[0].text}`;
  for (const { index, text: memberText } of kept.slice(1)) {
    out += text.slice(members[index - 1].end, members[index].start) + memberText;
  }
  return `${text.slice(0, node.start)}${out}${trail}}${text.slice(node.end)}`;
}

/** Why a copy can't change mechanically, or null when it can. */
function blockedBecause(site, target, targetSchema, adopt) {
  if (adopt) return null;
  for (const key of Object.keys(targetSchema)) {
    if (DOCUMENT_METADATA.has(key) || key in constraintsOf(targetSchema)) continue;
    if (JSON.stringify(targetSchema[key]) !== JSON.stringify(site.node[key])) {
      return `${target.ref} states ${key}, which the site doesn't (pass --adopt-annotations to adopt it)`;
    }
  }
  return null;
}

const at = (root, pointer) => pointer.split('/').slice(1)
  .reduce((node, raw) => node?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')], root);

function readArgs(args) {
  const options = { write: false, sites: new Set(), doc: null, properties: [], adopt: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') options.write = true;
    else if (args[i] === '--site') options.sites.add(args[++i]);
    else if (args[i] === '--doc') options.doc = args[++i];
    else if (args[i] === '--property') options.properties = args[++i].split(',');
    else if (args[i] === '--adopt-annotations') options.adopt = true;
    else throw new Error(`unknown argument ${args[i]}`);
  }
  return options;
}

function main() {
  const options = readArgs(process.argv.slice(2));
  const documents = loadDocuments(SCHEMAS_DIR);
  const sites = collectSites(documents);
  const named = indexNamedSchemas(documents, sites);
  let chosenEntry = null;
  if (options.doc) {
    const [docFile, docPointer] = options.doc.split('#');
    chosenEntry = [...named.values()].flat().find((doc) => (docPointer
      ? doc.local && doc.file === docFile && doc.pointer === docPointer
      : !doc.local && doc.file === docFile));
    if (!chosenEntry) throw new Error(`${options.doc} is not a named scalar schema`);
    for (const property of options.properties) chosenEntry.properties.add(property);
  }
  const edits = new Map();
  const blocked = [];
  for (const { site, targets } of findInlineCopies(sites, named)) {
    const key = siteKey(site);
    if (options.sites.size > 0 && !options.sites.has(key)) continue;
    const chosen = chosenEntry ? targets.filter((doc) => doc === chosenEntry) : targets;
    if (chosenEntry && chosen.length === 0) continue;
    if (chosen.length !== 1) {
      blocked.push(`${key}: choose one of ${chosen.map((doc) => doc.ref).join(', ')}`);
      continue;
    }
    const [target] = chosen;
    const targetDocument = documents.find((document) => document.file === target.file).schema;
    const targetSchema = target.local ? at(targetDocument, target.pointer) : targetDocument;
    const reason = blockedBecause(site, target, targetSchema, options.adopt);
    if (reason) {
      blocked.push(`${key}: ${reason}`);
      continue;
    }
    // Every validating key of the site goes, because the target states them all.
    const removeKeys = Object.keys(site.node).filter((key) => !isAnnotation(key) || (key === 'x-entity' && target.xEntity));
    if (!edits.has(site.file)) edits.set(site.file, []);
    edits.get(site.file).push({ pointer: site.pointer, removeKeys, ref: target.ref });
    console.log(`${key} -> ${target.ref}`);
  }
  for (const line of blocked) console.log(`needs a decision: ${line}`);
  const count = [...edits.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(`${count} site(s) in ${edits.size} document(s)${options.write ? '' : ' would change; rerun with --write to apply'}. ${blocked.length} need a decision.`);
  if (!options.write || count === 0) return;

  for (const [file, list] of edits) {
    const full = path.join(SCHEMAS_DIR, file);
    let text = fs.readFileSync(full, 'utf8');
    const tree = parseWithPositions(text);
    const ordered = list.map((edit) => ({ edit, node: locate(tree, edit.pointer) })).sort((a, b) => b.node.start - a.node.start);
    for (const { edit, node } of ordered) text = rewriteSite(text, node, edit.removeKeys, edit.ref);
    JSON.parse(text);
    fs.writeFileSync(full, text);
  }
  const proof = spawnSync(process.execPath, ['--test', path.join('tests', 'named-schema-extraction.test.cjs')], {
    cwd: REPO_ROOT,
    env: { ...process.env, SCHEMA_EXTRACTION_BASE: 'HEAD' },
    stdio: 'inherit',
  });
  if (proof.status !== 0) process.exit(proof.status || 1);
}

if (require.main === module) main();

module.exports = { parseWithPositions, rewriteSite };
