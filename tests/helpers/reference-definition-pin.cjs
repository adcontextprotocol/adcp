'use strict';

/**
 * Reference implementation of the definition-pin projection and digest.
 *
 * The rules table is read from the published vectors so the normative rules
 * exist in exactly one machine-readable place. Implementers port this file,
 * not the prose.
 */

const crypto = require('node:crypto');
const { canonicalize } = require('@adcp/sdk');

function jcs(value) {
  return canonicalize(value);
}

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// Project one published entry per the kind's rules. `rules` is the entry of
// projection_rules[kind]; `rulesByName` resolves nested projections by name.
function project(entry, rules, rulesByName) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('entry and nested elements must be objects');
  }
  const excluded = new Set(rules.exclude);
  // fromEntries creates own data properties, so a published member literally
  // named "__proto__" stays in the preimage instead of being dropped or
  // replacing the prototype.
  const out = Object.fromEntries(Object.entries(entry).filter(([key]) => !excluded.has(key)));
  for (const key of rules.set_arrays) {
    if (!Array.isArray(out[key])) continue;
    out[key] = normalizeSet(out[key]);
  }
  for (const [key, nested] of Object.entries(rules.nested || {})) {
    if (!Array.isArray(out[key])) continue;
    const nestedRules = rulesByName[nested];
    out[key] = normalizeSet(
      out[key].map(item => project(item, nestedRules, rulesByName)),
    );
  }
  return out;
}

// De-duplicate by JCS bytes and sort ascending by the UTF-8 bytes of the JCS
// serialization. Elements arrive already projected.
function normalizeSet(items) {
  const byBytes = new Map();
  for (const item of items) byBytes.set(jcs(item), item);
  return [...byBytes.keys()].sort(compareUtf8).map(key => byBytes.get(key));
}

// A published entry must be I-JSON (RFC 7493) for JCS to be well defined.
// This strict parser rejects what JSON.parse silently accepts or corrupts:
// duplicate member names, lone surrogates, numbers a double cannot hold
// exactly or that are not finite, and nesting deeper than MAX_DEPTH. A
// verifier treats a rejected entry as unresolvable (changed). Objects are
// built from own data properties so a member named "__proto__" is preserved.
const MAX_DEPTH = 64;

function parsePublishedEntry(raw) {
  let i = 0;
  const fail = message => {
    throw new Error(`${message} at offset ${i}`);
  };
  const ws = () => {
    while (i < raw.length && ' \t\n\r'.includes(raw[i])) i++;
  };
  const string = () => {
    if (raw[i] !== '"') fail('expected string');
    const start = i++;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    if (raw[i] !== '"') fail('unterminated string');
    i++;
    const value = JSON.parse(raw.slice(start, i));
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) {
      fail('lone surrogate in string');
    }
    return value;
  };
  const value = depth => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    ws();
    const c = raw[i];
    if (c === '{') {
      i++;
      const members = new Map();
      ws();
      if (raw[i] === '}') {
        i++;
        return {};
      }
      for (;;) {
        ws();
        const key = string();
        if (members.has(key)) fail(`duplicate member name ${JSON.stringify(key)}`);
        ws();
        if (raw[i++] !== ':') fail('expected colon');
        members.set(key, value(depth + 1));
        ws();
        if (raw[i] === ',') {
          i++;
          continue;
        }
        if (raw[i++] !== '}') fail('expected comma or closing brace');
        return Object.fromEntries(members);
      }
    }
    if (c === '[') {
      i++;
      const items = [];
      ws();
      if (raw[i] === ']') {
        i++;
        return items;
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (raw[i] === ',') {
          i++;
          continue;
        }
        if (raw[i++] !== ']') fail('expected comma or closing bracket');
        return items;
      }
    }
    if (c === '"') return string();
    const literal = /^(?:true|false|null)/.exec(raw.slice(i, i + 5));
    if (literal) {
      i += literal[0].length;
      return JSON.parse(literal[0]);
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i));
    if (!number) fail('unexpected token');
    i += number[0].length;
    const n = Number(number[0]);
    if (!Number.isFinite(n)) fail('number is not finite');
    if (/^-?\d+$/.test(number[0]) && !Number.isSafeInteger(n)) fail('integer is not exactly representable');
    if (!/^-?\d+$/.test(number[0]) && /^-?\d{16,}\./.test(number[0])) fail('number loses precision');
    return n;
  };
  const result = value(0);
  ws();
  if (i !== raw.length) fail('trailing characters');
  return result;
}

function contentDigest(entry, kind, projectionRules) {
  const rules = projectionRules[kind];
  const projection = project(entry, rules, projectionRules);
  const bytes = jcs(projection);
  return {
    projection,
    jcs_bytes: bytes,
    content_digest: crypto.createHash('sha256').update(bytes, 'utf8').digest('hex'),
  };
}

function termsDigest(commercialTerms) {
  return `sha256:${crypto.createHash('sha256').update(jcs(commercialTerms), 'utf8').digest('base64url')}`;
}

function comparePins(a, b) {
  return (
    compareUtf8(a.ref_kind, b.ref_kind) || compareUtf8(jcs(a.reference), jcs(b.reference))
  );
}

module.exports = { parsePublishedEntry, jcs, project, normalizeSet, contentDigest, termsDigest, comparePins, compareUtf8 };
