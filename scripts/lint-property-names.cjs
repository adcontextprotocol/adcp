#!/usr/bin/env node
/**
 * Property-name lint: a property's name tells you its type and meaning, and
 * one concept has one name (#8902).
 *
 * The lint walks every property declaration under the schema tree and
 * applies seven rules:
 *
 *   casing          names are lower_snake_case
 *   suffix-type     a time suffix fixes the type: _at date-time, _date date,
 *                   _time time of day, _duration ISO 8601 duration, and a
 *                   unit suffix (_ms, _seconds, ... _days) a number
 *   type-suffix     a date-time, date, time-of-day or duration value carries
 *                   its suffix (instants and dates may also end in a time
 *                   preposition: _from, _until, _before, _after, _since,
 *                   _through, as_of)
 *   synonym         one spelling per concept: names and words listed as
 *                   variants in the registry, and counts not named
 *                   `<thing>_count`
 *   plural-scalar   a plural name typed as a single string
 *   singular-array  a singular name typed as an array
 *   one-type        one property name, one JSON type across the tree
 *
 * `_id` constraints belong to the ID-types check (#8899) and `_url` typing to
 * the URL-convention check (#8900). This lint checks only their names and
 * JSON types.
 *
 * Examples, defaults, const and enum values are never walked as schemas.
 * Properties declared inside if/then/else/not/dependencies refine a property
 * declared elsewhere, so only `casing` applies to them.
 *
 * lint-property-names-registry.json holds the reviewed choices: synonym
 * groups, permanent exemptions with a reason each (the A2UI mirror schemas,
 * JSON Schema keywords), and the word lists the plural rules use. Existing
 * findings are in lint-property-names-baseline.json. A new finding fails.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  escapePointerToken,
  isSchema,
  loadSchemaTree,
  resolveRef,
  runCli,
  walkSchema,
} = require('./schema-convention-lint.cjs');

const DEFAULT_REGISTRY_PATH = path.join(__dirname, 'lint-property-names-registry.json');
const DEFAULT_BASELINE_PATH = path.join(__dirname, 'lint-property-names-baseline.json');

const RULES = [
  'casing',
  'suffix-type',
  'type-suffix',
  'synonym',
  'plural-scalar',
  'singular-array',
  'one-type',
];

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const REFINEMENT_SEGMENT = /\/(?:if|then|else|not|dependencies|dependentSchemas)(?:\/|$)/;


// ---------------------------------------------------------------------------
// Type signatures
//
// A signature is a JSON type, with `integer` folded into `number`, `null`
// dropped, string temporal formats kept (`string:date-time`, `string:date`,
// `string:time`, `string:duration`) and arrays written as `array<item>`.
// A schema whose alternatives have different signatures is a union.

const TEMPORAL_SAMPLES = {
  'date-time': ['2026-11-10T12:30:00Z', '2026-11-10T12:30:00.000Z', '2026-11-10T12:30:00+01:00'],
  date: ['2026-11-10'],
  time: ['12:30', '12:30:00'],
  duration: ['P1D', 'PT30M', 'P1Y2M10DT2H30M'],
};

// A pattern that also accepts ordinary words, domains or ratios is not a
// temporal pattern, even if a temporal sample happens to match it.
const NON_TEMPORAL_SAMPLES = [
  'hello',
  'example.com',
  'abc_def-123',
  'abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '99:99',
  '16:9',
  '50%',
  'XY12',
];

function temporalFromPattern(pattern) {
  let regex;
  try {
    regex = new RegExp(pattern, 'u');
  } catch {
    return null;
  }
  if (NON_TEMPORAL_SAMPLES.some((sample) => regex.test(sample))) return null;
  const hits = Object.entries(TEMPORAL_SAMPLES)
    .filter(([, samples]) => samples.some((sample) => regex.test(sample)))
    .map(([kind]) => kind);
  return hits.length === 1 ? hits[0] : null;
}

function stringSignature(schema) {
  if (schema.format === 'date-time') return 'string:date-time';
  if (schema.format === 'date') return 'string:date';
  if (schema.format === 'time') return 'string:time';
  if (schema.format === 'duration') return 'string:duration';
  if (typeof schema.pattern === 'string') {
    const kind = temporalFromPattern(schema.pattern);
    if (kind) return `string:${kind}`;
  }
  return 'string';
}

function jsonTypeOf(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return 'array<any>';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function collapse(signatures) {
  // A const/enum string branch next to a formatted string branch is a keyword
  // alternative (for example 'asap' next to a date-time); it does not change
  // the type the name promises. Keywords stay marked until `finalize`.
  const set = new Set(signatures);
  set.delete('any');
  const formatted = [...set].some((s) => s.startsWith('string:') && s !== 'string:keyword');
  if (formatted) set.delete('string:keyword');
  return set;
}

function finalize(set) {
  return new Set([...set].map((s) => (s === 'string:keyword' ? 'string' : s)));
}

function signature(schema, document, registry, seen = new Set()) {
  if (schema === true) return new Set(['any']);
  if (!isSchema(schema)) return new Set();

  if (typeof schema.$ref === 'string') {
    const marker = `${document.relativePath}|${schema.$ref}`;
    if (seen.has(marker)) return new Set(['any']);
    const resolved = resolveRef(schema.$ref, document, registry);
    if (!resolved) return new Set(['unresolved']);
    const nextSeen = new Set(seen);
    nextSeen.add(marker);
    return signature(resolved.node, resolved.document, registry, nextSeen);
  }

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type])
      .filter((type) => type !== 'null');
    const out = [];
    for (const type of types) {
      if (type === 'array') out.push(arraySignature(schema, document, registry, seen));
      else if (type === 'integer' || type === 'number') out.push('number');
      else if (type === 'string') {
        const plain = stringSignature(schema);
        if (plain === 'string' && (Array.isArray(schema.enum) || 'const' in schema)) {
          out.push('string:keyword');
        } else if (plain === 'string' && (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf))) {
          out.push(...alternatives(schema, document, registry, seen).filter((s) => s.startsWith('string')));
          if (out.length === 0) out.push('string');
        } else out.push(plain);
      } else out.push(type);
    }
    return collapse(out);
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    const type = jsonTypeOf(schema.const);
    return new Set(type ? [type === 'string' ? 'string:keyword' : type] : []);
  }
  if (Array.isArray(schema.enum)) {
    return collapse(schema.enum.map(jsonTypeOf).filter(Boolean)
      .map((type) => (type === 'string' ? 'string:keyword' : type)));
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const alts = alternatives(schema, document, registry, seen);
    if (alts.length > 0) return collapse(alts);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const sig = collapse(signature(branch, document, registry, seen));
      if (sig.size > 0) return sig;
    }
  }
  if (isSchema(schema.properties) || schema.additionalProperties !== undefined ||
      schema.propertyNames !== undefined || Array.isArray(schema.required) ||
      isSchema(schema.patternProperties)) {
    return new Set(['object']);
  }
  if (schema.items !== undefined) return new Set([arraySignature(schema, document, registry, seen)]);
  if (typeof schema.pattern === 'string' || typeof schema.format === 'string' ||
      schema.minLength !== undefined || schema.maxLength !== undefined) {
    return new Set([stringSignature(schema)]);
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined ||
      schema.exclusiveMinimum !== undefined || schema.exclusiveMaximum !== undefined) {
    return new Set(['number']);
  }
  return new Set(['any']);
}

function alternatives(schema, document, registry, seen) {
  const out = [];
  for (const keyword of ['oneOf', 'anyOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) out.push(...signature(branch, document, registry, seen));
  }
  return out;
}

function arraySignature(schema, document, registry, seen) {
  if (!isSchema(schema.items)) return 'array<any>';
  const item = finalize(collapse(signature(schema.items, document, registry, seen)));
  if (item.size === 0) return 'array<any>';
  return `array<${[...item].sort().join('|')}>`;
}

function summarize(sigSet) {
  const sigs = [...finalize(collapse(sigSet))].sort();
  if (sigs.length === 0) return { sig: 'any', union: false };
  if (sigs.length > 1) return { sig: sigs.join('|'), union: true };
  return { sig: sigs[0], union: sigs[0].includes('|') };
}

// ---------------------------------------------------------------------------
// Collecting property declarations

function collectProperties(registry) {
  const sites = [];
  for (const document of registry.documents) {
    for (const { node, pointer } of walkSchema(document.schema)) {
      if (!isSchema(node.properties)) continue;
      for (const [name, child] of Object.entries(node.properties)) {
        const childPointer = `${pointer}/properties/${escapePointerToken(name)}`;
        sites.push({
          document,
          file: document.relativePath,
          pointer: childPointer,
          path: `${document.relativePath}#${childPointer}`,
          name,
          schema: child,
          refinement: REFINEMENT_SEGMENT.test(childPointer),
        });
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Name analysis

function tokens(name) {
  return name.split('_').filter(Boolean);
}

function makeNameTools(config) {
  const massNouns = new Set(config.massNouns || []);
  const collectiveNouns = new Set(config.collectiveNouns || []);
  const irregularPlurals = new Map(Object.entries(config.irregularPlurals || {}));
  const unitTokens = new Set(config.unitTokens || []);
  const qualifierTokens = new Set(config.qualifierTokens || []);
  const relationTokens = new Set(config.relationTokens || []);

  // The nouns a name is about. Trailing qualifiers are dropped, so
  // `languages_any` is judged on `languages`. A relation word in the middle
  // splits the name into two noun phrases (`formats_to_provide`,
  // `assigned_to_packages`). A name that starts or ends with a relation word
  // (`by_package`, `superseded_by`) or is only a qualifier (`exclude`) names a
  // relation, not the value, so there is nothing to judge (empty list).
  function headNouns(name) {
    const parts = tokens(name);
    if (relationTokens.has(parts[0]) || relationTokens.has(parts[parts.length - 1])) return [];
    const phrases = [[]];
    for (const part of parts) {
      if (relationTokens.has(part)) phrases.push([]);
      else phrases[phrases.length - 1].push(part);
    }
    const heads = [];
    for (const phrase of phrases) {
      while (phrase.length > 0 && qualifierTokens.has(phrase[phrase.length - 1])) phrase.pop();
      if (phrase.length > 0) heads.push(phrase[phrase.length - 1]);
    }
    return heads;
  }

  function isNeutral(word) {
    return massNouns.has(word) || collectiveNouns.has(word) || unitTokens.has(word);
  }

  function isPluralWord(word) {
    if (isNeutral(word)) return false;
    if (irregularPlurals.has(word)) return true;
    if (/(?:ss|us|is)$/.test(word)) return false;
    return word.length > 2 && word.endsWith('s');
  }

  function isSingularWord(word) {
    return !isNeutral(word) && !isPluralWord(word);
  }

  function singular(word) {
    if (irregularPlurals.has(word)) return irregularPlurals.get(word);
    if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
    if (/(?:ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
    return word.endsWith('s') ? word.slice(0, -1) : word;
  }

  // A count of things is `<thing>_count`. `total_<things>`, `<things>_total`
  // and `num_<things>` are other spellings of it.
  function countSpelling(name, sig) {
    if (sig !== 'number') return null;
    const parts = tokens(name);
    let noun = null;
    if ((parts[0] === 'total' || parts[0] === 'num') && parts.length > 1) noun = parts.slice(1);
    else if (parts[parts.length - 1] === 'total' && parts.length > 1) noun = parts.slice(0, -1);
    if (!noun || !isPluralWord(noun[noun.length - 1])) return null;
    noun[noun.length - 1] = singular(noun[noun.length - 1]);
    return `${noun.join('_')}_count`;
  }

  return { headNouns, isPluralWord, isSingularWord, countSpelling, unitTokens };
}

// Instants and calendar dates may also be named by a preposition that takes
// them (`valid_from`, `created_before`, `as_of`), because the preposition says
// the value is a point in time.
const TIME_PREPOSITION = /(?:^|_)(?:after|before|from|until|since|through|as_of)$/;

function expectedFromSuffix(name, nameTools) {
  const parts = tokens(name);
  const last = parts[parts.length - 1];
  if (name.endsWith('_at')) return { suffix: '_at', expect: ['string:date-time'] };
  if (name === 'timestamp' || name.endsWith('_timestamp')) return { suffix: 'timestamp', expect: ['string:date-time'] };
  if (name.endsWith('_date')) return { suffix: '_date', expect: ['string:date'] };
  if (name.endsWith('_dates')) return { suffix: '_dates', expect: ['array<string:date>'] };
  if (name.endsWith('_time')) return { suffix: '_time', expect: ['string:time'] };
  if (name.endsWith('_times')) return { suffix: '_times', expect: ['array<string:time>'] };
  if (name === 'duration' || name.endsWith('_duration')) return { suffix: '_duration', expect: ['string:duration'] };
  if (name.endsWith('_durations')) return { suffix: '_durations', expect: ['array<string:duration>'] };
  if (parts.length > 1 && nameTools.unitTokens.has(last)) return { suffix: `_${last}`, expect: ['number'] };
  return null;
}

function expectedSuffixForType(sig) {
  if (sig === 'string:date-time' || sig === 'array<string:date-time>') return { kind: 'date-time', suffixes: ['_at'] };
  if (sig === 'string:date' || sig === 'array<string:date>') return { kind: 'date', suffixes: ['_date', '_dates'] };
  if (sig === 'string:time' || sig === 'array<string:time>') return { kind: 'time of day', suffixes: ['_time', '_times'] };
  if (sig === 'string:duration' || sig === 'array<string:duration>') return { kind: 'ISO 8601 duration', suffixes: ['_duration', '_durations'] };
  return null;
}

function nameCarriesSuffix(name, kind) {
  if (TIME_PREPOSITION.test(name) && (kind === 'date-time' || kind === 'date')) return true;
  if (kind === 'date-time') return name === 'at' || name.endsWith('_at');
  if (kind === 'date') return name === 'date' || name === 'dates' || name.endsWith('_date') || name.endsWith('_dates');
  if (kind === 'time of day') return name === 'time' || name.endsWith('_time') || name.endsWith('_times');
  if (kind === 'ISO 8601 duration') return name === 'duration' || name.endsWith('_duration') || name.endsWith('_durations');
  return false;
}

// ---------------------------------------------------------------------------
// Rules

function analyze(registry, config) {
  const nameTools = makeNameTools(config);
  const sites = collectProperties(registry);
  const variantToCanonical = new Map();
  for (const group of config.synonyms || []) {
    for (const variant of group.variants) variantToCanonical.set(variant, group);
  }
  const tokenToCanonical = new Map();
  for (const group of config.tokenSynonyms || []) {
    for (const variant of group.variants) tokenToCanonical.set(variant, group);
  }
  const exemptions = config.exemptions || [];
  const siteExempt = (site, rule) => exemptions.some((entry) =>
    (entry.rule === rule || entry.rule === '*') && !entry.match.startsWith('name:') &&
    site.path.startsWith(entry.match));

  for (const site of sites) {
    const s = summarize(signature(site.schema, site.document, registry));
    site.sig = s.sig;
    site.union = s.union;
  }

  const findings = [];
  const add = (rule, site, message, key) => findings.push({
    rule,
    path: site ? site.path : null,
    key: key || `${rule}:${site.path}`,
    name: site ? site.name : null,
    message,
  });

  for (const site of sites) {
    const { name } = site;
    // casing applies everywhere a property name appears, refinements included.
    if (!SNAKE_CASE.test(name)) {
      add('casing', site, `\`${name}\` is not lower_snake_case`);
    }
    if (site.refinement) continue;

    const fromSuffix = expectedFromSuffix(name, nameTools);
    if (fromSuffix) {
      if (!fromSuffix.expect.includes(site.sig)) {
        add('suffix-type', site, `\`${name}\` ends in \`${fromSuffix.suffix}\`, which means ${fromSuffix.expect.join(' or ')}, but the schema is ${site.sig}`);
      }
    }

    const forType = expectedSuffixForType(site.sig);
    if (forType && !nameCarriesSuffix(name, forType.kind)) {
      add('type-suffix', site, `\`${name}\` holds ${forType.kind.startsWith('ISO') ? 'an' : 'a'} ${forType.kind} value, so its name ends in \`${forType.suffixes[0]}\``);
    }

    const group = variantToCanonical.get(name);
    if (group) {
      add('synonym', site, `\`${name}\` is a variant of \`${group.canonical}\` (${group.concept})`);
    } else if (SNAKE_CASE.test(name)) {
      const parts = tokens(name);
      const variants = parts.filter((part) => tokenToCanonical.has(part));
      const count = nameTools.countSpelling(name, site.sig);
      if (variants.length > 0) {
        const canonical = parts.map((part) => (tokenToCanonical.has(part) ? tokenToCanonical.get(part).canonical : part)).join('_');
        const words = variants.map((v) => `\`${v}\` as \`${tokenToCanonical.get(v).canonical}\``).join(', ');
        add('synonym', site, `\`${name}\`: the registry spells ${words}, so the name is \`${canonical}\``);
      } else if (count) {
        add('synonym', site, `\`${name}\` is a count; counts are named \`<thing>_count\` (\`${count}\`)`);
      }
    }

    // Plural rules judge snake_case names only; other names are casing findings.
    const heads = SNAKE_CASE.test(name) ? nameTools.headNouns(name) : [];
    if (heads.length > 0 && !site.union) {
      if (site.sig.startsWith('string') && heads.some(nameTools.isPluralWord)) {
        add('plural-scalar', site, `\`${name}\` is plural but holds a single ${site.sig}`);
      }
      if (site.sig.startsWith('array<') && heads.every(nameTools.isSingularWord)) {
        add('singular-array', site, `\`${name}\` is singular but holds an ${site.sig}`);
      }
    }
  }

  // one-type: group declaration sites by name; unions and untyped sites are
  // left out of the comparison.
  const byName = new Map();
  for (const site of sites) {
    if (site.refinement || site.union || site.sig.includes('any') || site.sig === 'unresolved') continue;
    if (siteExempt(site, 'one-type')) continue;
    if (!byName.has(site.name)) byName.set(site.name, new Map());
    const bySig = byName.get(site.name);
    if (!bySig.has(site.sig)) bySig.set(site.sig, []);
    bySig.get(site.sig).push(site);
  }
  for (const [name, bySig] of [...byName.entries()].sort()) {
    if (bySig.size < 2) continue;
    const parts = [...bySig.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([sig, list]) => `${sig} ×${list.length} (e.g. ${list[0].path})`);
    findings.push({
      rule: 'one-type',
      path: null,
      key: `one-type:${name}`,
      name,
      types: [...bySig.keys()].sort(),
      message: `\`${name}\` has ${bySig.size} types: ${parts.join('; ')}`,
    });
  }

  return { sites, findings };
}

// ---------------------------------------------------------------------------
// Registry (reviewed, permanent) and baseline (legacy, may only shrink)

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return { value: fallback, error: `missing file: ${file}` };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { value: fallback, error: `invalid JSON in ${file}: ${error.message}` };
  }
}

function validateConfig(config) {
  const errors = [];
  const seenVariants = new Set();
  for (const [index, group] of (config.synonyms || []).entries()) {
    const label = `synonyms[${index}]`;
    if (typeof group.canonical !== 'string' || !SNAKE_CASE.test(group.canonical)) {
      errors.push(`${label}.canonical must be a lower_snake_case name`);
    }
    if (!Array.isArray(group.variants) || group.variants.length === 0) {
      errors.push(`${label}.variants must be a non-empty array`);
    } else {
      for (const variant of group.variants) {
        if (variant === group.canonical) errors.push(`${label}: canonical listed as its own variant`);
        if (seenVariants.has(variant)) errors.push(`${label}: variant \`${variant}\` appears in two groups`);
        seenVariants.add(variant);
      }
    }
    if (typeof group.concept !== 'string' || group.concept.length < 8) errors.push(`${label}.concept must say what the name means`);
  }
  for (const [index, group] of (config.tokenSynonyms || []).entries()) {
    const label = `tokenSynonyms[${index}]`;
    if (typeof group.canonical !== 'string' || !Array.isArray(group.variants) || group.variants.length === 0) {
      errors.push(`${label} needs a canonical word and variants`);
    }
    if (typeof group.concept !== 'string' || group.concept.length < 8) errors.push(`${label}.concept must say why`);
  }
  for (const [index, entry] of (config.exemptions || []).entries()) {
    const label = `exemptions[${index}]`;
    if (entry.rule !== '*' && !RULES.includes(entry.rule)) errors.push(`${label}.rule must be * or one of ${RULES.join(', ')}`);
    if (typeof entry.match !== 'string' || entry.match.length === 0) errors.push(`${label}.match is required`);
    if (typeof entry.rationale !== 'string' || entry.rationale.trim().length < 12) errors.push(`${label}.rationale must explain the exception`);
  }
  return errors;
}

// An exemption matches a finding key. `match` is a schema-relative path
// prefix (`a2ui/` or `core/x.json#/properties/y`), or `name:<property>` for a
// name-level rule such as one-type.
function isExempt(finding, exemptions) {
  return exemptions.some((entry) => {
    if (entry.rule !== finding.rule && entry.rule !== '*') return false;
    if (entry.match.startsWith('name:')) return finding.name === entry.match.slice(5);
    return finding.path !== null && finding.path.startsWith(entry.match);
  });
}

function lintPropertyNames({ schemasDir, registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  const tree = loadSchemaTree(schemasDir);
  const errors = tree.parseErrors.map((error) => `schema parse error: ${error}`);
  const configResult = loadJson(registryPath, {});
  if (configResult.error) errors.push(configResult.error);
  const config = configResult.value;
  errors.push(...validateConfig(config));

  const { sites, findings } = analyze(tree, config);
  const exemptions = config.exemptions || [];
  const open = findings.filter((finding) => !isExempt(finding, exemptions));
  const declarations = sites.filter((site) => !site.refinement).length;
  return {
    findings: open.map((finding) => ({
      rule: finding.rule,
      site: finding.rule === 'one-type' ? `name:${finding.name} (${finding.types.join(',')})` : finding.path,
      message: finding.message,
    })),
    errors,
    report: [`${sites.length} property sites (${declarations} declarations), ${findings.length - open.length} findings exempt by the registry`],
  };
}

module.exports = {
  DEFAULT_BASELINE_PATH,
  RULES,
  SNAKE_CASE,
  analyze,
  collectProperties,
  lintPropertyNames,
  makeNameTools,
  signature,
  summarize,
  temporalFromPattern,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const registryIndex = args.indexOf('--registry');
  const registryPath = registryIndex !== -1 ? path.resolve(args[registryIndex + 1]) : DEFAULT_REGISTRY_PATH;
  process.exitCode = runCli({
    name: 'property-name lint',
    defaultBaselinePath: DEFAULT_BASELINE_PATH,
    baselineComment: 'Property names that break the naming convention (scripts/lint-property-names.cjs, #8902). A new finding fails. Renames are 4.0 changes; reviewed permanent exceptions belong in lint-property-names-registry.json, not here.',
    lint: (options) => lintPropertyNames({ ...options, registryPath }),
  });
}
