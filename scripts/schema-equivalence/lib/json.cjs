'use strict';

/** JSON with object keys sorted at every level; arrays keep their order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Sorted, de-duplicated copy of a JSON array, compared by stable JSON. */
function sortedSet(values) {
  const seen = new Map();
  for (const v of values) {
    const key = stableStringify(v);
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.keys()].sort().map(k => seen.get(k));
}

function escapePointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The value at a JSON pointer, or `undefined` when the path does not exist. */
function getPointer(doc, ptr) {
  if (ptr === '') return doc;
  if (!ptr.startsWith('/')) return undefined;
  let cur = doc;
  for (const raw of ptr.slice(1).split('/')) {
    const seg = unescapePointer(raw);
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** The JSON type of a value; integers report `integer`. */
function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

module.exports = { stableStringify, sortedSet, escapePointer, unescapePointer, getPointer, jsonType };
