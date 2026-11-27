#!/usr/bin/env node
/**
 * Enum-value lint: every enum value can become an identifier in the
 * languages AdCP is implemented in (#8901, as agreed on #8791).
 *
 * A value site is a string `enum`, a string `const`, or the keys of a
 * top-level `vocabulary` object, outside `propertyNames`. Sites under a
 * `deprecated: true` schema and values listed in `x-deprecated-enum-values`
 * are skipped: they leave in 4.0.
 *
 * Rules:
 *
 *   fold-collision      two values of one site, or the `const` values of one
 *                       discriminator (the same property across the branches
 *                       of one oneOf/anyOf), are equal once lowercased with
 *                       everything but letters and digits removed
 *                       (`clickTag`/`clickTAG`, `media-buy`/`media_buy`).
 *   reserved-word       a value equals a reserved word of Python, Go, Java or
 *                       TypeScript, case included.
 *   enum-protocol-name  a value equals an attribute or method every Python or
 *                       Java enum has: name, value, values, ordinal, valueOf.
 *
 * Existing findings are in lint-enum-values-baseline.json. A new finding
 * fails, so every new vocabulary starts clean.
 */

'use strict';

const path = require('node:path');
const {
  isSchema,
  loadSchemaTree,
  runCli,
  unescapePointerToken,
  walkSchema,
} = require('./schema-convention-lint.cjs');

const DEFAULT_BASELINE_PATH = path.join(__dirname, 'lint-enum-values-baseline.json');

// Python 3 keywords; Go keywords (not predeclared identifiers such as
// `error`); Java reserved keywords plus the literals true, false, null;
// TypeScript reserved and strict-mode reserved words.
const RESERVED = {
  Python: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  Go: 'break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var',
  Java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null',
  TypeScript: 'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with implements interface let package private protected public static yield',
};
const RESERVED_SETS = Object.entries(RESERVED).map(([language, words]) => [language, new Set(words.split(' '))]);
const ENUM_PROTOCOL_NAMES = new Set(['name', 'value', 'values', 'ordinal', 'valueOf']);
const DISCRIMINATOR_CONST = /^(.*\/(?:oneOf|anyOf))\/\d+\/properties\/([^/]+)\/const$/;

function foldToken(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function reservedIn(value) {
  return RESERVED_SETS.filter(([, words]) => words.has(value)).map(([language]) => language);
}

/** Every value site, with the values that are still live. */
function collectSites(tree) {
  const sites = [];
  for (const document of tree.documents) {
    for (const { node, pointer, ancestors } of walkSchema(document.schema)) {
      let keyword = null;
      let values = null;
      if (Array.isArray(node.enum) && node.enum.some((value) => typeof value === 'string')) {
        keyword = 'enum';
        values = node.enum.filter((value) => typeof value === 'string');
      } else if (typeof node.const === 'string') {
        keyword = 'const';
        values = [node.const];
      }
      if (!keyword) continue;
      if (pointer.split('/').map(unescapePointerToken).includes('propertyNames')) continue;
      if (ancestors.some((entry) => entry.node.deprecated === true) || node.deprecated === true) continue;
      const deprecatedValues = new Set(Array.isArray(node['x-deprecated-enum-values']) ? node['x-deprecated-enum-values'] : []);
      sites.push({
        path: `${document.relativePath}#${pointer}/${keyword}`,
        keyword,
        values: values.filter((value) => !deprecatedValues.has(value)),
      });
    }
    const vocabulary = isSchema(document.schema) ? document.schema.vocabulary : undefined;
    if (isSchema(vocabulary)) {
      sites.push({ path: `${document.relativePath}#/vocabulary`, keyword: 'vocabulary', values: Object.keys(vocabulary) });
    }
  }
  return sites.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function foldCollisions(values) {
  const byToken = new Map();
  for (const value of values) {
    const token = foldToken(value);
    if (!byToken.has(token)) byToken.set(token, new Set());
    byToken.get(token).add(value);
  }
  return [...byToken.values()].filter((set) => set.size > 1).map((set) => [...set].sort());
}

function lintEnumValues({ schemasDir } = {}) {
  const tree = loadSchemaTree(schemasDir);
  const errors = tree.parseErrors.map((error) => `schema parse error: ${error}`);
  const sites = collectSites(tree);
  const findings = [];
  const discriminators = new Map();

  for (const site of sites) {
    for (const values of foldCollisions(site.values)) {
      findings.push({
        rule: 'fold-collision',
        site: `${site.path} (${values.join('|')})`,
        message: `${values.join(' and ')} fold to one identifier`,
      });
    }
    for (const value of site.values) {
      const languages = reservedIn(value);
      if (languages.length) {
        findings.push({ rule: 'reserved-word', site: `${site.path} (${value})`, message: `\`${value}\` is reserved in ${languages.join(', ')}` });
      }
      if (ENUM_PROTOCOL_NAMES.has(value)) {
        findings.push({
          rule: 'enum-protocol-name',
          site: `${site.path} (${value})`,
          message: `\`${value}\` is an attribute or method of every Python or Java enum`,
        });
      }
    }
    const match = site.keyword === 'const' && site.values.length === 1 && site.path.match(DISCRIMINATOR_CONST);
    if (match) {
      const group = `${match[1]}/*/properties/${match[2]}/const`;
      if (!discriminators.has(group)) discriminators.set(group, []);
      discriminators.get(group).push(site.values[0]);
    }
  }
  for (const [group, values] of discriminators) {
    for (const collision of foldCollisions(values)) {
      findings.push({
        rule: 'fold-collision',
        site: `${group} (${collision.join('|')})`,
        message: `discriminator values ${collision.join(' and ')} fold to one identifier`,
      });
    }
  }

  const valueCount = sites.reduce((sum, site) => sum + site.values.length, 0);
  return {
    findings: findings.sort((a, b) => `${a.rule} ${a.site}`.localeCompare(`${b.rule} ${b.site}`, 'en')),
    errors,
    report: [`${sites.length} value sites, ${valueCount} live values, ${discriminators.size} const discriminators`],
  };
}

module.exports = { DEFAULT_BASELINE_PATH, collectSites, foldToken, lintEnumValues, reservedIn };

if (require.main === module) {
  process.exitCode = runCli({
    name: 'enum-value lint',
    defaultBaselinePath: DEFAULT_BASELINE_PATH,
    baselineComment: 'Enum values that can\'t become an identifier as they are (scripts/lint-enum-values.cjs, #8901). A new finding fails. Entries leave as values are deprecated or renamed in 4.0; the four `name` positions #8791 declined and the reserved words no target language trips on stay.',
    lint: lintEnumValues,
  });
}
