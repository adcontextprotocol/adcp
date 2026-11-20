'use strict';

/**
 * The construct catalog's schema pairs, before any verdict is decided.
 *
 * Each entry names a construct, a base and a head schema, and the authoring
 * intent (`equivalent` or `different`). The intent is only a cross-check for
 * the author: the stored verdict comes from the offline oracle, or from a
 * hand proof (`manual`) for constructs the oracle does not model like Ajv
 * (`format`, `uniqueItems`, `.` in a pattern, lookahead, astral characters).
 *
 * Snippet pairs are placed in contexts the AdCP bundle uses (top level,
 * inside `allOf`, under `not`, behind a `$ref` to another file, inside a
 * recursive definition, inside a `discriminator` branch). Multi-file pairs
 * give their files directly.
 */

const ALL_CONTEXTS = ['top', 'allOf', 'not', 'ref', 'cycle', 'discriminator'];
const MISS_CONTEXTS = ['top', 'not'];
const KEYWORD_CONTEXTS = ['top', 'ref'];

/** Moves a snippet's `definitions` to the enclosing file, so `#/definitions/x` still resolves. */
function hoist(s) {
  if (!s || typeof s !== 'object' || !s.definitions) return [s, {}];
  const { definitions, ...rest } = s;
  return [rest, definitions];
}

const withDefs = (doc, defs) => (Object.keys(defs).length ? { ...doc, definitions: { ...(doc.definitions || {}), ...defs } } : doc);

/** Context name -> { wrap(snippet) -> files, lift(payload) -> payload at the root }. */
const CONTEXTS = {
  top: {
    wrap: (s) => ({ 'a.json': typeof s === 'boolean' ? { allOf: [s] } : s }),
    lift: (w) => w,
    flips: false,
  },
  allOf: {
    wrap: (s) => {
      const [r, d] = hoist(s);
      return { 'a.json': withDefs({ allOf: [r, { maxProperties: 64 }] }, d) };
    },
    lift: (w) => w,
    flips: false,
  },
  not: {
    wrap: (s) => {
      const [r, d] = hoist(s);
      return { 'a.json': withDefs({ not: r }, d) };
    },
    lift: (w) => w,
    flips: true,
  },
  ref: {
    wrap: (s) => ({
      'a.json': { type: 'object', properties: { v: { $ref: 'b.json' } } },
      'b.json': typeof s === 'boolean' ? { allOf: [s] } : s,
    }),
    lift: (w) => ({ v: w }),
    flips: false,
  },
  cycle: {
    wrap: (s) => {
      const [r, d] = hoist(s);
      return {
        'a.json': withDefs({
          definitions: { node: { type: 'object', properties: { v: r, next: { $ref: '#/definitions/node' } } } },
          $ref: '#/definitions/node',
        }, d),
      };
    },
    lift: (w) => ({ v: w }),
    flips: false,
  },
  discriminator: {
    wrap: (s) => {
      const [r, d] = hoist(s);
      return {
        'a.json': withDefs({
          type: 'object',
          discriminator: { propertyName: 'kind' },
          oneOf: [
            { type: 'object', properties: { kind: { const: 'a' }, v: r }, required: ['kind'] },
            { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] },
          ],
        }, d),
      };
    },
    lift: (w) => ({ kind: 'a', v: w }),
    flips: false,
  },
};

// Shared branches for union constructs.
const VIDEO = { type: 'object', properties: { kind: { const: 'video' }, duration: { type: 'number' } }, required: ['kind'] };
const IMAGE = { type: 'object', properties: { kind: { const: 'image' }, width: { type: 'integer' } }, required: ['kind'] };
const AUDIO = { type: 'object', properties: { kind: { const: 'audio' }, bitrate: { type: 'integer' } }, required: ['kind'] };
const untyped = (b) => {
  const { type, ...rest } = b;
  return rest;
};
const str = (extra = {}) => ({ type: 'string', ...extra });
const pat = (p) => ({ type: 'string', pattern: p });
const obj = (extra = {}) => ({ type: 'object', ...extra });
const arr = (extra = {}) => ({ type: 'array', ...extra });
const DISC = { propertyName: 'kind' };

/**
 * Snippet groups. Each item: [name, base, head, intent, options].
 * `intent` is `eq` (equivalent) or `diff`. Options: `contexts`, `manual`,
 * `note` (the description).
 */
const SNIPPETS = [
  {
    group: 'rules', construct: 'annotations', rule: 'annotation keywords are dropped',
    items: [
      ['annotations-dropped', str({ maxLength: 5 }), str({ maxLength: 5, title: 'Name', description: 'A name.', examples: ['abc'], $comment: 'c', deprecated: true, readOnly: true, writeOnly: true }), 'eq'],
      ['informational-keywords', str({ maxLength: 5 }), str({ maxLength: 5, default: 'abc', 'x-status': 'stable', enumDescriptions: { abc: 'x' } }), 'eq'],
      ['unused-definitions', str({ maxLength: 5 }), { ...str({ maxLength: 5 }), definitions: { unused: { type: 'number' } } }, 'eq'],
      ['referenced-definition-changed', { $ref: '#/definitions/name', definitions: { name: str({ maxLength: 5 }) } }, { $ref: '#/definitions/name', definitions: { name: str({ maxLength: 4 }) } }, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'ref-siblings', rule: '$ref with sibling keywords is the conjunction of the target and the siblings',
    items: [
      ['ref-sibling-is-conjunction', { $ref: '#/definitions/s', maxLength: 5, definitions: { s: str({ minLength: 1 }) } }, str({ minLength: 1, maxLength: 5 }), 'eq'],
      ['ref-sibling-as-allof', { $ref: '#/definitions/s', maxLength: 5, definitions: { s: str({ minLength: 1 }) } }, { allOf: [{ $ref: '#/definitions/s' }, { maxLength: 5 }], definitions: { s: str({ minLength: 1 }) } }, 'eq'],
      ['ref-sibling-dropped', { $ref: '#/definitions/s', maxLength: 5, definitions: { s: str({ minLength: 1 }) } }, { $ref: '#/definitions/s', definitions: { s: str({ minLength: 1 }) } }, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'allof', rule: 'allOf is flattened, true and duplicate members dropped, members a set, one member is the member',
    items: [
      ['nested-allof-flattened', { allOf: [str(), { allOf: [{ minLength: 1 }, { maxLength: 5 }] }] }, { allOf: [str(), { minLength: 1 }, { maxLength: 5 }] }, 'eq'],
      ['true-members-dropped', { allOf: [str(), true, {}] }, str(), 'eq'],
      ['duplicate-member-dropped', { allOf: [str(), { minLength: 1 }, { minLength: 1 }] }, { allOf: [{ minLength: 1 }, str()] }, 'eq'],
      ['member-order', { allOf: [str(), { pattern: '^a' }] }, { allOf: [{ pattern: '^a' }, str()] }, 'eq'],
      ['single-member', { allOf: [str({ minLength: 1 })] }, str({ minLength: 1 }), 'eq'],
      ['allof-to-anyof', { allOf: [str(), { minLength: 2 }] }, { anyOf: [str(), { minLength: 2 }] }, 'diff'],
      ['false-member', { allOf: [str(), false] }, str(), 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'conjunction-merge', rule: 'conjunction members merge into one schema object where no keyword reads a sibling in its own object',
    items: [
      ['disjoint-keywords', { allOf: [str(), { maxLength: 5 }] }, str({ maxLength: 5 }), 'eq'],
      ['required-union', { allOf: [obj({ required: ['a'] }), { required: ['b'] }] }, obj({ required: ['a', 'b'] }), 'eq'],
      ['same-property-conjoined', { allOf: [{ properties: { a: str() } }, { properties: { a: { maxLength: 3 } } }] }, { properties: { a: str({ maxLength: 3 }) } }, 'eq'],
      ['tighter-bound-kept', { allOf: [str({ maxLength: 5 }), { maxLength: 3 }] }, str({ maxLength: 3 }), 'eq'],
      ['type-intersection', { allOf: [{ type: ['integer', 'string'] }, { type: 'number' }] }, { type: 'integer' }, 'eq'],
      ['ref-target-and-siblings', { $ref: '#/definitions/o', required: ['b'], definitions: { o: obj({ properties: { a: str() }, required: ['a'] }) } }, obj({ properties: { a: str() }, required: ['a', 'b'] }), 'eq'],
      ['additional-properties-sees-own-properties', { allOf: [obj({ properties: { a: str() } }), { additionalProperties: false }] }, obj({ properties: { a: str() }, additionalProperties: false }), 'diff'],
      ['pattern-properties-beside-additional-properties', { allOf: [obj({ patternProperties: { '^x-': str() } }), { additionalProperties: false }] }, obj({ patternProperties: { '^x-': str() }, additionalProperties: false }), 'diff'],
      ['additional-items-sees-own-items', { allOf: [arr({ items: [str()] }), { additionalItems: false }] }, arr({ items: [str()], additionalItems: false }), 'diff'],
      ['two-patterns-both-apply', { allOf: [pat('^a'), { pattern: 'b$' }] }, pat('^a'), 'diff'],
      ['if-groups-stay-apart', { allOf: [{ if: { required: ['a'] }, then: { required: ['b'] } }, { if: { required: ['c'] }, then: { required: ['d'] } }] }, { if: { required: ['a'] }, then: { required: ['d'] } }, 'diff'],
      ['inclusive-and-exclusive-bounds', { allOf: [{ type: 'number', minimum: 0 }, { exclusiveMinimum: 0 }] }, { type: 'number', minimum: 0 }, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'single-branch-union', rule: 'a one-branch anyOf or oneOf is its branch, except a oneOf under discriminator',
    items: [
      ['single-anyof', { anyOf: [str({ minLength: 1 })] }, str({ minLength: 1 }), 'eq'],
      ['single-oneof', { oneOf: [str({ minLength: 1 })] }, str({ minLength: 1 }), 'eq'],
      ['single-oneof-under-discriminator', { discriminator: DISC, oneOf: [VIDEO] }, VIDEO, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'union-order', rule: 'anyOf branches are a set, oneOf branches a multiset',
    items: [
      ['anyof-branch-order', { anyOf: [str(), { type: 'integer', minimum: 0 }] }, { anyOf: [{ type: 'integer', minimum: 0 }, str()] }, 'eq'],
      ['oneof-branch-order', { oneOf: [str(), { maxLength: 3 }] }, { oneOf: [{ maxLength: 3 }, str()] }, 'eq'],
      ['anyof-duplicate-branch', { anyOf: [str(), str(), { type: 'integer' }] }, { anyOf: [str(), { type: 'integer' }] }, 'eq'],
      ['oneof-duplicate-branch', { oneOf: [str(), str(), { type: 'integer' }] }, { oneOf: [str(), { type: 'integer' }] }, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'value-sets', rule: 'type, enum and required are sets; a one-value enum is const',
    items: [
      ['type-string-vs-list', str(), { type: ['string'] }, 'eq'],
      ['type-list-order', { type: ['string', 'null'] }, { type: ['null', 'string'] }, 'eq'],
      ['enum-order', { enum: ['a', 'b', 'c'] }, { enum: ['c', 'a', 'b'] }, 'eq'],
      ['enum-single-is-const', { enum: ['a'] }, { const: 'a' }, 'eq'],
      ['const-object-key-order', { const: { x: 1, y: 'b' } }, { enum: [{ y: 'b', x: 1 }] }, 'eq'],
      ['required-order', obj({ required: ['a', 'b'] }), obj({ required: ['b', 'a'] }), 'eq'],
      ['type-list-member-removed', { type: ['string', 'null'] }, str(), 'diff'],
      ['enum-value-type-changed', { enum: [1] }, { enum: ['1'] }, 'diff'],
      ['required-member-removed', obj({ required: ['a', 'b'] }), obj({ required: ['a'] }), 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'zero-bounds', rule: 'required: [], minLength: 0, minItems: 0, minProperties: 0 and uniqueItems: false are absent',
    items: [
      ['required-empty', obj({ required: [] }), obj(), 'eq'],
      ['minlength-zero', str({ minLength: 0 }), str(), 'eq'],
      ['minitems-zero', arr({ minItems: 0 }), arr(), 'eq'],
      ['minproperties-zero', obj({ minProperties: 0 }), obj(), 'eq'],
      ['uniqueitems-false', arr({ uniqueItems: false }), arr(), 'eq', { manual: { base_in_head: true, head_in_base: true, reason: 'uniqueItems: false asserts nothing (draft-07 section 6.4.3: "If it has boolean value true, the instance validates successfully if all of its elements are unique"; false omits the check, and Ajv generates no code for it).', witnesses: [[1, 1], []] } }],
      ['minlength-one', str({ minLength: 1 }), str(), 'diff'],
      ['minitems-one', arr({ minItems: 1 }), arr(), 'diff'],
      ['minproperties-one', obj({ minProperties: 1 }), obj(), 'diff'],
      ['uniqueitems-true', arr({ uniqueItems: true }), arr(), 'diff', { manual: { base_in_head: true, head_in_base: false, reason: 'uniqueItems: true only removes arrays with equal elements, so the base is inside the head; [1, 1] is in the head only.', witnesses: [[1, 1]] } }],
    ],
  },
  {
    group: 'rules', construct: 'type-beside-values', rule: 'type next to const or enum is dropped when every value has a listed type',
    items: [
      ['type-implied-by-const', str({ const: 'a' }), { const: 'a' }, 'eq'],
      ['type-list-implied-by-enum', { type: ['string', 'integer'], enum: ['a', 1] }, { enum: ['a', 1] }, 'eq'],
      ['number-implied-by-integer-and-fraction', { type: 'number', enum: [1, 2.5] }, { enum: [1, 2.5] }, 'eq'],
      ['type-excludes-enum-value', str({ enum: ['a', 1] }), { enum: ['a', 1] }, 'diff'],
      ['integer-excludes-fraction', { type: 'integer', enum: [1, 2.5] }, { enum: [1, 2.5] }, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'true-subschemas', rule: 'true subschemas equal absence; then/else without if and if without then/else are dropped',
    items: [
      ['additionalproperties-true', obj({ properties: { a: str() }, additionalProperties: true }), obj({ properties: { a: str() } }), 'eq'],
      ['items-true', arr({ items: true }), arr(), 'eq'],
      ['additionalitems-true', arr({ items: [str()], additionalItems: true }), arr({ items: [str()] }), 'eq'],
      ['propertynames-true', obj({ propertyNames: true }), obj(), 'eq'],
      ['then-true', { if: str(), then: true, else: { const: 5 } }, { if: str(), else: { const: 5 } }, 'eq'],
      ['else-empty', { if: str(), then: { minLength: 1 }, else: {} }, { if: str(), then: { minLength: 1 } }, 'eq'],
      ['then-without-if', str({ then: { const: 'a' } }), str(), 'eq'],
      ['else-without-if', str({ else: { const: 'a' } }), str(), 'eq'],
      ['if-without-branches', str({ if: { const: 'a' } }), str(), 'eq'],
      ['additionalitems-without-tuple', arr({ items: str(), additionalItems: false }), arr({ items: str() }), 'eq'],
      ['additionalproperties-false', obj({ properties: { a: {} }, additionalProperties: false }), obj({ properties: { a: {} }, additionalProperties: true }), 'diff'],
      ['contains-true-is-not-absent', arr({ contains: true }), arr(), 'diff'],
      ['then-with-if', { if: str(), then: { minLength: 1 } }, {}, 'diff'],
      ['additionalitems-false-with-tuple', arr({ items: [str()], additionalItems: false }), arr({ items: [str()] }), 'diff'],
      ['items-false', arr({ items: false }), arr(), 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'type-pruning-and-split', rule: 'keywords for types the node does not allow are dropped; a multi-type node splits into one branch per type',
    items: [
      ['string-keywords-on-null', { type: 'null', minLength: 3, pattern: '^a' }, { type: 'null' }, 'eq'],
      ['foreign-keywords-on-string', str({ minimum: 3, required: ['a'], minItems: 2 }), str(), 'eq'],
      ['string-keyword-on-integer', { type: 'integer', maxLength: 2 }, { type: 'integer' }, 'eq'],
      ['type-split', { type: ['string', 'number'], minLength: 2, minimum: 0 }, { anyOf: [str({ minLength: 2 }), { type: 'number', minimum: 0 }] }, 'eq'],
      ['nullable-string-split', { type: ['string', 'null'], maxLength: 3 }, { anyOf: [str({ maxLength: 3 }), { type: 'null' }] }, 'eq'],
      ['string-keyword-on-string-or-null', { type: ['string', 'null'], minLength: 3 }, { type: ['string', 'null'] }, 'diff'],
      ['number-keyword-on-integer', { type: 'integer', minimum: 3 }, { type: 'integer' }, 'diff'],
      ['type-split-drops-bound', { type: ['string', 'number'], minLength: 2, minimum: 0 }, { anyOf: [str({ minLength: 2 }), { type: 'number' }] }, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'value-unions', rule: 'an anyOf of value-only branches is one enum; a oneOf only when its value sets do not overlap',
    items: [
      ['anyof-of-values', { anyOf: [{ const: 'a' }, { const: 'b' }, { enum: ['c'] }] }, { enum: ['a', 'b', 'c'] }, 'eq'],
      ['oneof-of-disjoint-values', { oneOf: [{ const: 'a' }, { enum: ['b', 'c'] }] }, { enum: ['a', 'b', 'c'] }, 'eq'],
      ['anyof-of-values-with-own-enum', { enum: ['a', 'b', 'x'], anyOf: [{ const: 'a' }, { const: 'b' }] }, { enum: ['a', 'b'] }, 'eq'],
      ['oneof-of-overlapping-values', { oneOf: [{ enum: ['a', 'b'] }, { enum: ['b', 'c'] }] }, { enum: ['a', 'b', 'c'] }, 'diff'],
      ['anyof-of-values-drops-one', { anyOf: [{ const: 'a' }, { const: 'b' }] }, { const: 'a' }, 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'propertynames-strings', rule: 'propertyNames is read in a string-instance context',
    items: [
      ['string-type-dropped', obj({ propertyNames: str({ maxLength: 3 }) }), obj({ propertyNames: { maxLength: 3 } }), 'eq'],
      ['non-string-branch-dropped', obj({ propertyNames: { anyOf: [{ type: 'integer' }, { pattern: '^a' }] } }), obj({ propertyNames: { pattern: '^a' } }), 'eq'],
      ['through-ref', { ...obj({ propertyNames: { $ref: '#/definitions/code' } }), definitions: { code: str({ pattern: '^[A-Z]{2}$' }) } }, obj({ propertyNames: { pattern: '^[A-Z]{2}$' } }), 'eq'],
      ['nullable-type-dropped', obj({ propertyNames: { type: ['string', 'null'], minLength: 1 } }), obj({ propertyNames: { minLength: 1 } }), 'eq'],
      ['object-keywords-dropped', obj({ propertyNames: { maxLength: 3, required: ['x'], minimum: 2 } }), obj({ propertyNames: { maxLength: 3 } }), 'eq'],
      ['discriminator-passes-strings', obj({ propertyNames: { discriminator: { propertyName: 'k' }, oneOf: [obj({ properties: { k: { const: 'a' } }, required: ['k'] }), obj({ properties: { k: { const: 'b' } }, required: ['k'] })] } }), obj(), 'eq'],
      ['integer-type-rejects-names', obj({ propertyNames: { type: 'integer' } }), obj(), 'diff'],
      ['not-string-rejects-names', obj({ propertyNames: { not: str() } }), obj(), 'diff'],
      ['discriminator-is-not-false', obj({ propertyNames: { discriminator: { propertyName: 'k' }, oneOf: [obj({ properties: { k: { const: 'a' } }, required: ['k'] }), obj({ properties: { k: { const: 'b' } }, required: ['k'] })] } }), obj({ propertyNames: false }), 'diff'],
    ],
  },
  {
    group: 'rules', construct: 'regex-spelling', rule: 'patterns compare in a canonical spelling: \\d is [0-9], a bracket class is a sorted interval set',
    items: [
      ['digit-escape', pat('^\\d{3}$'), pat('^[0-9]{3}$'), 'eq'],
      ['class-order', pat('^[a-zA-Z_]+$'), pat('^[_A-Za-z]+$'), 'eq'],
      ['class-ranges-merged', pat('^[a-cd-f]$'), pat('^[a-f]$'), 'eq'],
      ['class-list-as-range', pat('^[abc]$'), pat('^[a-c]$'), 'eq'],
      ['class-hex-escape', pat('^[\\x41-\\x43]$'), pat('^[A-C]$'), 'eq'],
      ['class-escaped-dash', pat('^[\\-a]$'), pat('^[a-]$'), 'eq'],
      ['class-digit-escape', pat('^[\\da-f]$'), pat('^[0-9a-f]$'), 'eq'],
      ['class-escape-order', pat('^[\\s\\w]$'), pat('^[\\w\\s]$'), 'eq'],
      ['class-negated', pat('^[0-9]$'), pat('^[^0-9]$'), 'diff'],
      ['digit-vs-non-digit', pat('^\\d$'), pat('^\\D$'), 'diff'],
      ['class-range-shrunk', pat('^[a-z]$'), pat('^[a-y]$'), 'diff'],
      ['class-dash-as-range-start', pat('^[--/]$'), pat('^[\\-/]$'), 'diff', { manual: { base_in_head: false, head_in_base: true, reason: 'In a u-mode class a literal "-" may start a range: [--/] is the range U+002D..U+002F, so it adds "." to [\\-/].', witnesses: ['.'] } }],
      ['class-dash-as-range-end', pat('^[!--]$'), pat('^[!\\-]$'), 'diff', { manual: { base_in_head: false, head_in_base: true, reason: 'In a u-mode class a literal "-" may end a range: [!--] is the range U+0021..U+002D, so it adds "#" and the rest of that range to [!\\-].', witnesses: ['#'] } }],
      ['class-surrogate-pair-escape', pat('^[\\uD83D\\uDE00]$'), pat('^[\\u{D83D}\\u{DE00}]$'), 'diff', { manual: { base_in_head: false, head_in_base: false, reason: 'With the u flag, \\uD83D\\uDE00 is one code point (U+1F600), while \\u{D83D}\\u{DE00} are two lone surrogates. The oracle counts astral characters as two units, so this pair is decided by hand.', witnesses: ['\u{1F600}', '\uD83D'] } }],
    ],
  },
  {
    group: 'branches', construct: 'oneof-to-anyof', rule: 'oneOf-to-anyOf: a oneOf over pairwise-disjoint branches is an anyOf',
    items: [
      ['separated-by-const', { oneOf: [VIDEO, IMAGE] }, { anyOf: [VIDEO, IMAGE] }, 'eq'],
      ['separated-by-type', { oneOf: [str({ minLength: 1 }), { type: 'integer' }] }, { anyOf: [str({ minLength: 1 }), { type: 'integer' }] }, 'eq'],
      ['separated-by-const-under-parent-type', obj({ oneOf: [untyped(VIDEO), untyped(IMAGE)] }), obj({ anyOf: [untyped(VIDEO), untyped(IMAGE)] }), 'eq'],
      ['separated-by-values', { oneOf: [{ enum: ['a', 'b'], minLength: 1 }, { const: 'c', maxLength: 3 }] }, { anyOf: [{ enum: ['a', 'b'], minLength: 1 }, { const: 'c', maxLength: 3 }] }, 'eq'],
      ['tag-required-by-parent', obj({ required: ['kind'], oneOf: [{ properties: { kind: { const: 'a' } } }, { properties: { kind: { const: 'b' } } }] }), obj({ required: ['kind'], anyOf: [{ properties: { kind: { const: 'a' } } }, { properties: { kind: { const: 'b' } } }] }), 'eq'],
      ['separated-by-required-and-not-required', obj({ oneOf: [{ required: ['a'], not: { required: ['b'] } }, { required: ['b'], not: { required: ['a'] } }] }), obj({ anyOf: [{ required: ['a'], not: { required: ['b'] } }, { required: ['b'], not: { required: ['a'] } }] }), 'eq'],
      ['separated-by-one-sided-not-required', obj({ oneOf: [{ required: ['a'], not: { required: ['b'] } }, { required: ['b'] }] }), obj({ anyOf: [{ required: ['a'], not: { required: ['b'] } }, { required: ['b'] }] }), 'eq'],
      ['overlapping-branches', { oneOf: [str(), str({ minLength: 2 })] }, { anyOf: [str(), str({ minLength: 2 })] }, 'diff'],
      ['branches-not-objects', { oneOf: [untyped(VIDEO), untyped(IMAGE)] }, { anyOf: [untyped(VIDEO), untyped(IMAGE)] }, 'diff'],
      ['tag-not-required', { oneOf: [obj({ properties: { k: { const: 'a' } } }), obj({ properties: { k: { const: 'b' } } })] }, { anyOf: [obj({ properties: { k: { const: 'a' } } }), obj({ properties: { k: { const: 'b' } } })] }, 'diff'],
      ['not-separated', { oneOf: [obj({ required: ['a'] }), obj({ required: ['b'] })] }, { anyOf: [obj({ required: ['a'] }), obj({ required: ['b'] })] }, 'diff'],
      ['not-required-on-other-property', obj({ oneOf: [{ required: ['a'], not: { required: ['c'] } }, { required: ['b'] }] }), obj({ anyOf: [{ required: ['a'], not: { required: ['c'] } }, { required: ['b'] }] }), 'diff'],
    ],
  },
  {
    group: 'branches', construct: 'discriminator-to-anyof', rule: 'discriminator-to-anyOf: discriminator with oneOf is an anyOf when the node only admits objects and Ajv accepts the mapping',
    items: [
      ['object-parent', obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE] }), obj({ anyOf: [VIDEO, IMAGE] }), 'eq'],
      ['ref-branches', { ...obj({ discriminator: DISC, oneOf: [{ $ref: '#/definitions/video' }, { $ref: '#/definitions/image' }] }), definitions: { video: VIDEO, image: IMAGE } }, obj({ anyOf: [VIDEO, IMAGE] }), 'eq'],
      ['discriminator-vs-plain-oneof', obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE] }), obj({ oneOf: [VIDEO, IMAGE] }), 'eq'],
      ['enum-tags', obj({ discriminator: DISC, oneOf: [obj({ properties: { kind: { enum: ['video', 'clip'] } }, required: ['kind'] }), IMAGE] }), obj({ anyOf: [obj({ properties: { kind: { enum: ['video', 'clip'] } }, required: ['kind'] }), IMAGE] }), 'eq'],
      ['no-object-parent', { discriminator: DISC, oneOf: [VIDEO, IMAGE] }, { anyOf: [VIDEO, IMAGE] }, 'diff'],
      ['discriminator-removed-without-object-parent', { discriminator: DISC, oneOf: [VIDEO, IMAGE] }, { oneOf: [VIDEO, IMAGE] }, 'diff'],
    ],
  },
  {
    group: 'branches', construct: 'not-branch-subtraction', rule: 'not-branch-subtraction: allOf [U, not B] with B a branch of U and the rest disjoint from B is U without B',
    items: [
      ['anyof-const-branches', { allOf: [{ anyOf: [VIDEO, IMAGE, AUDIO] }, { not: IMAGE }] }, { anyOf: [VIDEO, AUDIO] }, 'eq'],
      ['oneof-const-branches', { allOf: [{ oneOf: [VIDEO, IMAGE, AUDIO] }, { not: IMAGE }] }, { oneOf: [VIDEO, AUDIO] }, 'eq'],
      ['type-branches', { allOf: [{ anyOf: [str(), { type: 'integer' }, { type: 'null' }] }, { not: { type: 'null' } }] }, { anyOf: [str(), { type: 'integer' }] }, 'eq'],
      ['overlapping-branch', { allOf: [{ anyOf: [str(), str({ minLength: 3 })] }, { not: str({ minLength: 3 }) }] }, str(), 'diff'],
      ['not-operand-wider-than-branch', { allOf: [{ anyOf: [VIDEO, IMAGE, AUDIO] }, { not: untyped(IMAGE) }] }, { anyOf: [VIDEO, AUDIO] }, 'eq'],
      ['not-operand-narrower-than-branch', { allOf: [{ anyOf: [VIDEO, IMAGE, AUDIO] }, { not: { ...IMAGE, properties: { ...IMAGE.properties, width: { type: 'integer', minimum: 1 } } } }] }, { anyOf: [VIDEO, AUDIO] }, 'diff'],
    ],
  },
];

/**
 * Keyword changes: [name, base, head, intent ('tighten' | 'loosen' | 'diff'), options].
 * Placed at the top level and behind a $ref.
 */
const KEYWORDS = [
  ['type', [
    ['type-member-removed', { type: ['string', 'number'] }, str(), 'tighten'],
    ['type-member-added', str(), { type: ['string', 'null'] }, 'loosen'],
  ]],
  ['enum', [
    ['enum-value-removed', { enum: ['a', 'b', 'c'] }, { enum: ['a', 'b'] }, 'tighten'],
    ['enum-value-added', { enum: ['a', 'b'] }, { enum: ['a', 'b', 'c'] }, 'loosen'],
  ]],
  ['const', [
    ['const-added', str(), str({ const: 'a' }), 'tighten'],
    ['const-to-enum', { const: 'a' }, { enum: ['a', 'b'] }, 'loosen'],
  ]],
  ['pattern', [
    ['pattern-narrowed', pat('^[a-z]+$'), pat('^[a-z]{2,}$'), 'tighten'],
    ['pattern-widened', pat('^[a-z]+$'), pat('^[a-z0-9]+$'), 'loosen'],
  ]],
  ['minimum', [
    ['minimum-raised', { type: 'number', minimum: 0 }, { type: 'number', minimum: 1 }, 'tighten'],
    ['minimum-lowered', { type: 'number', minimum: 1 }, { type: 'number', minimum: 0 }, 'loosen'],
  ]],
  ['maximum', [
    ['maximum-lowered', { type: 'number', maximum: 10 }, { type: 'number', maximum: 9 }, 'tighten'],
    ['maximum-raised', { type: 'number', maximum: 9 }, { type: 'number', maximum: 10 }, 'loosen'],
  ]],
  ['exclusiveMinimum', [
    ['exclusive-minimum-added', { type: 'number', minimum: 0 }, { type: 'number', exclusiveMinimum: 0 }, 'tighten'],
    ['exclusive-minimum-lowered', { type: 'number', exclusiveMinimum: 1 }, { type: 'number', exclusiveMinimum: 0 }, 'loosen'],
  ]],
  ['exclusiveMaximum', [
    ['exclusive-maximum-lowered', { type: 'number', exclusiveMaximum: 10 }, { type: 'number', exclusiveMaximum: 9 }, 'tighten'],
    ['exclusive-maximum-to-maximum', { type: 'number', exclusiveMaximum: 10 }, { type: 'number', maximum: 10 }, 'loosen'],
  ]],
  ['minLength', [
    ['min-length-raised', str({ minLength: 1 }), str({ minLength: 2 }), 'tighten'],
    ['min-length-lowered', str({ minLength: 2 }), str({ minLength: 1 }), 'loosen'],
  ]],
  ['maxLength', [
    ['max-length-lowered', str({ maxLength: 10 }), str({ maxLength: 9 }), 'tighten'],
    ['max-length-removed', str({ maxLength: 10 }), str(), 'loosen'],
  ]],
  ['required', [
    ['required-added', obj({ properties: { a: str(), b: str() }, required: ['a'] }), obj({ properties: { a: str(), b: str() }, required: ['a', 'b'] }), 'tighten'],
    ['required-removed', obj({ properties: { a: str() }, required: ['a'] }), obj({ properties: { a: str() } }), 'loosen'],
  ]],
  ['properties', [
    ['property-schema-narrowed', obj({ properties: { a: str() } }), obj({ properties: { a: str({ maxLength: 3 }) } }), 'tighten'],
    ['property-schema-widened', obj({ properties: { a: str() } }), obj({ properties: { a: { type: ['string', 'null'] } } }), 'loosen'],
  ]],
  ['additionalProperties', [
    ['additional-properties-closed', obj({ properties: { a: str() } }), obj({ properties: { a: str() }, additionalProperties: false }), 'tighten'],
    ['additional-properties-schema-opened', obj({ properties: { a: str() }, additionalProperties: false }), obj({ properties: { a: str() }, additionalProperties: str() }), 'loosen'],
  ]],
  ['patternProperties', [
    ['pattern-property-added', obj(), obj({ patternProperties: { '^x-': str() } }), 'tighten'],
    ['pattern-property-schema-widened', obj({ patternProperties: { '^x-': str() } }), obj({ patternProperties: { '^x-': { type: ['string', 'number'] } } }), 'loosen'],
  ]],
  ['propertyNames', [
    ['property-names-added', obj(), obj({ propertyNames: { pattern: '^[a-z_]+$' } }), 'tighten'],
    ['property-names-widened', obj({ propertyNames: { pattern: '^[a-z_]+$' } }), obj({ propertyNames: { pattern: '^[a-z_0-9]+$' } }), 'loosen'],
  ]],
  ['minProperties', [
    ['min-properties-raised', obj({ minProperties: 1 }), obj({ minProperties: 2 }), 'tighten'],
    ['min-properties-lowered', obj({ minProperties: 2 }), obj({ minProperties: 1 }), 'loosen'],
  ]],
  ['maxProperties', [
    ['max-properties-lowered', obj({ maxProperties: 3 }), obj({ maxProperties: 2 }), 'tighten'],
    ['max-properties-raised', obj({ maxProperties: 2 }), obj({ maxProperties: 3 }), 'loosen'],
  ]],
  ['dependencies', [
    ['dependency-added', obj({ properties: { a: str(), b: str() } }), obj({ properties: { a: str(), b: str() }, dependencies: { a: ['b'] } }), 'tighten'],
    ['dependency-member-removed', obj({ dependencies: { a: ['b', 'c'] } }), obj({ dependencies: { a: ['b'] } }), 'loosen'],
    ['schema-dependency-narrowed', obj({ dependencies: { a: { required: ['b'] } } }), obj({ dependencies: { a: { required: ['b'], properties: { b: str() } } } }), 'tighten'],
  ]],
  ['items', [
    ['items-narrowed', arr({ items: str() }), arr({ items: str({ minLength: 1 }) }), 'tighten'],
    ['items-widened', arr({ items: str() }), arr({ items: { type: ['string', 'integer'] } }), 'loosen'],
  ]],
  ['minItems', [
    ['min-items-raised', arr({ minItems: 1 }), arr({ minItems: 2 }), 'tighten'],
    ['min-items-lowered', arr({ minItems: 2 }), arr({ minItems: 1 }), 'loosen'],
  ]],
  ['maxItems', [
    ['max-items-lowered', arr({ maxItems: 3 }), arr({ maxItems: 2 }), 'tighten'],
    ['max-items-raised', arr({ maxItems: 2 }), arr({ maxItems: 3 }), 'loosen'],
  ]],
  ['uniqueItems', [
    ['unique-items-added', arr({ items: str() }), arr({ items: str(), uniqueItems: true }), 'tighten', { manual: { base_in_head: false, head_in_base: true, reason: 'uniqueItems: true removes exactly the arrays with two equal elements.', witnesses: [['a', 'a']] } }],
    ['unique-items-removed', arr({ items: str(), uniqueItems: true }), arr({ items: str() }), 'loosen', { manual: { base_in_head: true, head_in_base: false, reason: 'uniqueItems: true removes exactly the arrays with two equal elements.', witnesses: [['a', 'a']] } }],
  ]],
  ['contains', [
    ['contains-added', arr(), arr({ contains: str() }), 'tighten'],
    ['contains-widened', arr({ contains: str({ minLength: 1 }) }), arr({ contains: str() }), 'loosen'],
  ]],
  ['format', [
    ['format-added', str(), str({ format: 'email' }), 'tighten', { manual: { base_in_head: false, head_in_base: true, reason: 'format adds a check to the same type, so the head is inside the base; "x" is no email address.', witnesses: ['x'] } }],
    ['format-removed', str({ format: 'uuid' }), str(), 'loosen', { manual: { base_in_head: true, head_in_base: false, reason: 'Removing format removes a check, so the base is inside the head; "x" is no uuid.', witnesses: ['x'] } }],
    ['format-date-time-to-date', str({ format: 'date-time' }), str({ format: 'date' }), 'diff', { manual: { base_in_head: false, head_in_base: false, reason: 'A date-time is never a date (a date is exactly 10 characters) and the reverse.', witnesses: ['2024-01-01T00:00:00Z', '2024-01-01'] } }],
    ['format-uri-to-uri-reference', str({ format: 'uri' }), str({ format: 'uri-reference' }), 'diff', { manual: { base_in_head: null, head_in_base: false, reason: 'A relative reference is a uri-reference and no uri.', witnesses: ['/a'] } }],
    ['format-hostname-bounded', str({ format: 'hostname' }), str({ format: 'hostname', maxLength: 253 }), 'tighten', { manual: { base_in_head: false, head_in_base: true, reason: 'ajv-formats hostname admits 253 characters plus a trailing dot, which maxLength 253 removes; maxLength only removes strings.', witnesses: [`${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(61)}.`] } }],
  ]],
  ['allOf', [
    ['allof-member-added', { allOf: [str()] }, { allOf: [str(), { maxLength: 3 }] }, 'tighten'],
    ['allof-member-removed', { allOf: [str(), { maxLength: 3 }] }, { allOf: [str()] }, 'loosen'],
  ]],
  ['anyOf', [
    ['anyof-branch-removed', { anyOf: [str(), { type: 'integer' }] }, { anyOf: [str()] }, 'tighten'],
    ['anyof-branch-added', { anyOf: [str(), { type: 'integer' }] }, { anyOf: [str(), { type: 'integer' }, { type: 'null' }] }, 'loosen'],
  ]],
  ['oneOf', [
    ['oneof-branch-removed', { oneOf: [str(), { type: 'integer' }] }, { oneOf: [str()] }, 'tighten'],
    ['oneof-disjoint-branch-added', { oneOf: [str(), { type: 'integer' }] }, { oneOf: [str(), { type: 'integer' }, { type: 'null' }] }, 'loosen'],
    ['oneof-overlapping-branch-added', { oneOf: [str(), { type: 'integer' }] }, { oneOf: [str(), { type: 'integer' }, { type: 'number', maximum: 0 }] }, 'diff'],
  ]],
  ['not', [
    ['not-broadened', { not: { const: 'a' } }, { not: { enum: ['a', 'b'] } }, 'tighten'],
    ['not-narrowed', { not: { enum: ['a', 'b'] } }, { not: { const: 'a' } }, 'loosen'],
  ]],
  ['if-then-else', [
    ['then-narrowed', { if: str(), then: { minLength: 1 } }, { if: str(), then: { minLength: 2 } }, 'tighten'],
    ['else-widened', { if: str(), then: { minLength: 1 }, else: { type: 'integer' } }, { if: str(), then: { minLength: 1 }, else: { type: ['integer', 'null'] } }, 'loosen'],
    ['if-narrowed', { if: str(), then: { maxLength: 5 } }, { if: str({ pattern: '^a' }), then: { maxLength: 5 } }, 'loosen'],
  ]],
  ['discriminator', [
    ['discriminator-removed', { discriminator: DISC, oneOf: [VIDEO, IMAGE] }, { oneOf: [VIDEO, IMAGE] }, 'tighten'],
    ['discriminator-branch-narrowed', obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE] }), obj({ discriminator: DISC, oneOf: [{ ...VIDEO, properties: { ...VIDEO.properties, duration: { type: 'number', minimum: 0 } } }, IMAGE] }), 'tighten'],
    ['discriminator-branch-added', obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE] }), obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE, AUDIO] }), 'loosen'],
  ]],
];

/**
 * Opaque constructs: the tool compares them exactly, with no reasoning.
 * Real changes must be reported; equivalent rewrites are allowed false alarms.
 */
const OPAQUE = [
  {
    construct: 'format', items: [
      ['format-uuid-implies-max-length', str({ format: 'uuid' }), str({ format: 'uuid', maxLength: 45 }), 'eq', { manual: { base_in_head: true, head_in_base: true, reason: 'ajv-formats 3.0.1 uuid is /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, at most 9 + 36 = 45 characters, so maxLength 45 removes nothing.', witnesses: ['urn:uuid:123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174000'] } }],
      ['format-date-implies-length', str({ format: 'date' }), str({ format: 'date', minLength: 10, maxLength: 10 }), 'eq', { manual: { base_in_head: true, head_in_base: true, reason: 'ajv-formats 3.0.1 full date matches /^(\\d\\d\\d\\d)-(\\d\\d)-(\\d\\d)$/ first, so every date is exactly 10 characters.', witnesses: ['2024-01-01', '2024-1-1'] } }],
      ['format-on-non-string', { type: 'integer', format: 'email' }, { type: 'integer' }, 'eq', { manual: { base_in_head: true, head_in_base: true, reason: 'ajv-formats email is a string format; Ajv applies it to strings only, so it asserts nothing on an integer.', witnesses: [1, 'x'] } }],
      ['format-changed', str({ format: 'date' }), str({ format: 'date-time' }), 'diff', { manual: { base_in_head: false, head_in_base: false, reason: 'A date is never a date-time and the reverse.', witnesses: ['2024-01-01', '2024-01-01T00:00:00Z'] } }],
    ],
  },
  {
    construct: 'pattern-semantics', items: [
      ['quantifier-spelling', pat('^a+$'), pat('^aa*$'), 'eq'],
      ['alternation-vs-class', pat('^(a|b)$'), pat('^[ab]$'), 'eq'],
      ['repeat-spelling', pat('^[a-z]{2}$'), pat('^[a-z][a-z]$'), 'eq'],
      ['redundant-group', pat('^(?:ab)$'), pat('^ab$'), 'eq'],
      ['pattern-implies-length', pat('^[A-Z]{3}$'), str({ pattern: '^[A-Z]{3}$', maxLength: 3 }), 'eq'],
      ['plus-to-star', pat('^[a-z]+$'), pat('^[a-z]*$'), 'diff'],
      ['anchor-removed', pat('^[a-z]+$'), pat('[a-z]+'), 'diff'],
      ['dot-excludes-newline', pat('^.$'), str({ minLength: 1, maxLength: 1 }), 'diff', { manual: { base_in_head: true, head_in_base: false, reason: 'In ECMAScript "." matches no line terminator, so "\\n" has length 1 and does not match ^.$. The oracle lets "." match a newline, so this pair is decided by hand.', witnesses: ['\n'] } }],
      ['lookahead-added', pat('^[a-z]+$'), pat('^(?!x)[a-z]+$'), 'diff', { manual: { base_in_head: false, head_in_base: true, reason: 'The lookahead only removes strings that start with "x". The oracle refuses lookahead.', witnesses: ['x'] } }],
      ['astral-length', str({ maxLength: 1 }), str({ maxLength: 1, not: { const: '\u{1F600}' } }), 'diff', { manual: { base_in_head: false, head_in_base: true, reason: 'Ajv counts code points, so "\u{1F600}" has length 1 and passes maxLength 1. The oracle counts UTF-16 units.', witnesses: ['\u{1F600}'] } }],
    ],
  },
  {
    construct: 'numeric-bounds', items: [
      ['integer-minimum-vs-exclusive', { type: 'integer', minimum: 1 }, { type: 'integer', exclusiveMinimum: 0 }, 'eq'],
      ['redundant-exclusive-maximum', { type: 'number', maximum: 5, exclusiveMaximum: 10 }, { type: 'number', maximum: 5 }, 'eq'],
      ['integer-as-multipleof-one', { type: 'integer' }, { type: 'number', multipleOf: 1 }, 'eq'],
      ['minimum-to-exclusive', { type: 'number', minimum: 0 }, { type: 'number', exclusiveMinimum: 0 }, 'diff'],
      ['multipleof-tightened', { type: 'number', multipleOf: 2 }, { type: 'number', multipleOf: 4 }, 'diff'],
    ],
  },
  {
    construct: 'discriminator-object', items: [
      ['extra-member-in-discriminator', { discriminator: DISC, oneOf: [VIDEO, IMAGE] }, { discriminator: { propertyName: 'kind', 'x-note': 'n' }, oneOf: [VIDEO, IMAGE] }, 'eq'],
      ['propertyname-changed', { discriminator: DISC, oneOf: [VIDEO, IMAGE] }, { discriminator: { propertyName: 'type' }, oneOf: [{ ...VIDEO, properties: { ...VIDEO.properties, type: { const: 'v' } }, required: ['kind', 'type'] }, { ...IMAGE, properties: { ...IMAGE.properties, type: { const: 'i' } }, required: ['kind', 'type'] }] }, 'diff'],
    ],
  },
  {
    construct: 'patternproperties-keys', items: [
      ['key-spelling', obj({ patternProperties: { '^\\d+$': str() } }), obj({ patternProperties: { '^[0-9]+$': str() } }), 'eq'],
      ['key-order', obj({ patternProperties: { '^a': str(), '^b': { type: 'integer' } } }), obj({ patternProperties: { '^b': { type: 'integer' }, '^a': str() } }), 'eq'],
      ['key-widened-closed', obj({ patternProperties: { '^[a-z]+$': str() }, additionalProperties: false }), obj({ patternProperties: { '^[a-z0-9]+$': str() }, additionalProperties: false }), 'diff'],
      ['key-widened-open', obj({ patternProperties: { '^[a-z]+$': str() } }), obj({ patternProperties: { '^[a-z0-9]+$': str() } }), 'diff'],
    ],
  },
  {
    construct: 'contains', items: [
      ['contains-anything-vs-min-items', arr({ contains: {} }), arr({ minItems: 1 }), 'eq'],
      ['contains-const-vs-enum', arr({ contains: { const: 1 } }), arr({ contains: { enum: [1] } }), 'eq'],
      ['contains-tightened', arr({ contains: str() }), arr({ contains: str({ minLength: 1 }) }), 'diff'],
    ],
  },
  {
    construct: 'not', items: [
      ['double-negation', { not: { not: str() } }, str(), 'eq'],
      ['de-morgan', { not: { anyOf: [str(), { type: 'null' }] } }, { allOf: [{ not: str() }, { not: { type: 'null' } }] }, 'eq'],
      ['not-type-as-complement', { not: str() }, { type: ['null', 'boolean', 'object', 'array', 'number'] }, 'eq'],
      ['not-broadened', { not: { const: 'a' } }, { not: { enum: ['a', 'b'] } }, 'diff'],
    ],
  },
  {
    construct: 'if-then-else', items: [
      ['if-then-as-anyof', { if: str(), then: { minLength: 1 } }, { anyOf: [{ not: str() }, str({ minLength: 1 })] }, 'eq'],
      ['negated-if-swaps-branches', { if: str(), then: { minLength: 1 }, else: { type: 'integer' } }, { if: { not: str() }, then: { type: 'integer' }, else: { minLength: 1 } }, 'eq'],
      ['then-implied', str({ if: { const: 'a' }, then: { minLength: 1 } }), str(), 'eq'],
      ['if-narrowed-without-effect', { if: str(), then: { minLength: 1 } }, { if: str({ maxLength: 5 }), then: { minLength: 1 } }, 'eq'],
      ['then-tightened', { if: str(), then: { minLength: 1 } }, { if: str(), then: { minLength: 1, maxLength: 9 } }, 'diff'],
    ],
  },
  {
    construct: 'uniqueitems', items: [
      ['unique-single-value', arr({ items: { const: 1 }, uniqueItems: true }), arr({ items: { const: 1 }, maxItems: 1 }), 'eq', { manual: { base_in_head: true, head_in_base: true, reason: 'Every item is 1, so the items are unique exactly when there is at most one.', witnesses: [[1, 1], [1], []] } }],
      ['unique-items-added', arr({ items: { type: 'integer' } }), arr({ items: { type: 'integer' }, uniqueItems: true }), 'diff', { manual: { base_in_head: false, head_in_base: true, reason: 'uniqueItems: true removes exactly the arrays with two equal elements.', witnesses: [[1, 1]] } }],
    ],
  },
  {
    construct: 'dependencies', items: [
      ['array-vs-schema-dependency', obj({ dependencies: { a: ['b'] } }), obj({ dependencies: { a: { required: ['b'] } } }), 'eq'],
      ['dependency-list-order', obj({ dependencies: { a: ['b', 'c'] } }), obj({ dependencies: { a: ['c', 'b'] } }), 'eq'],
    ],
  },
];

/**
 * Combinator nestings the bundle uses (most frequent first), each with an
 * equivalent restructuring and minimal tighten and loosen changes.
 */
const IF_BASE = obj({ properties: { mode: { enum: ['a', 'b'] }, x: str() }, if: { properties: { mode: { const: 'a' } }, required: ['mode'] }, then: { required: ['x'] } });
const NESTINGS = [
  ['ref-with-annotation-siblings', [
    ['annotation-siblings-dropped', { $ref: '#/definitions/t', description: 'Reason.', title: 'T', definitions: { t: str({ maxLength: 5 }) } }, { $ref: '#/definitions/t', definitions: { t: str({ maxLength: 5 }) } }, 'eq'],
    ['target-tightened', { $ref: '#/definitions/t', description: 'Reason.', definitions: { t: str({ maxLength: 5 }) } }, { $ref: '#/definitions/t', description: 'Reason.', definitions: { t: str({ maxLength: 4 }) } }, 'tighten'],
  ]],
  ['if-with-siblings', [
    ['then-in-single-allof', IF_BASE, { ...IF_BASE, then: { allOf: [{ required: ['x'] }] } }, 'eq'],
    ['if-broadened', IF_BASE, { ...IF_BASE, if: { properties: { mode: { enum: ['a', 'b'] } }, required: ['mode'] } }, 'tighten'],
    ['then-removed', IF_BASE, obj({ properties: { mode: { enum: ['a', 'b'] }, x: str() } }), 'loosen'],
  ]],
  ['anyof-alone', [
    ['branch-order', { anyOf: [str(), { type: 'integer' }] }, { anyOf: [{ type: 'integer' }, str()] }, 'eq'],
    ['branch-narrowed', { anyOf: [str(), { type: 'integer' }] }, { anyOf: [str(), { type: 'integer', minimum: 0 }] }, 'tighten'],
    ['branch-widened', { anyOf: [str({ maxLength: 3 }), { type: 'integer' }] }, { anyOf: [str(), { type: 'integer' }] }, 'loosen'],
  ]],
  ['allof-with-siblings', [
    ['sibling-moved-into-allof', obj({ required: ['a'], allOf: [{ properties: { a: str() } }] }), { allOf: [obj(), { required: ['a'] }, { properties: { a: str() } }] }, 'eq'],
    ['member-narrowed', obj({ required: ['a'], allOf: [{ properties: { a: str() } }] }), obj({ required: ['a'], allOf: [{ properties: { a: str({ minLength: 1 }) } }] }), 'tighten'],
    ['sibling-removed', obj({ required: ['a'], allOf: [{ properties: { a: str() } }] }), obj({ allOf: [{ properties: { a: str() } }] }), 'loosen'],
  ]],
  ['not-with-siblings', [
    ['not-moved-into-allof', str({ not: { const: 'x' } }), { allOf: [str(), { not: { const: 'x' } }] }, 'eq'],
    ['not-broadened', str({ not: { const: 'x' } }), str({ not: { enum: ['x', 'y'] } }), 'tighten'],
    ['not-removed', str({ not: { const: 'x' } }), str(), 'loosen'],
  ]],
  ['not-alone', [
    ['type-list-spelling', { not: { type: 'null' } }, { not: { type: ['null'] } }, 'eq'],
    ['not-broadened', { not: { type: 'null' } }, { not: { type: ['null', 'boolean'] } }, 'tighten'],
    ['not-narrowed', { not: { type: ['null', 'boolean'] } }, { not: { type: 'null' } }, 'loosen'],
  ]],
  ['anyof-with-siblings', [
    ['branch-order', obj({ properties: { a: str(), b: str() }, anyOf: [{ required: ['a'] }, { required: ['b'] }] }), obj({ properties: { a: str(), b: str() }, anyOf: [{ required: ['b'] }, { required: ['a'] }] }), 'eq'],
    ['branch-removed', obj({ properties: { a: str(), b: str() }, anyOf: [{ required: ['a'] }, { required: ['b'] }] }), obj({ properties: { a: str(), b: str() }, anyOf: [{ required: ['a'] }] }), 'tighten'],
    ['branch-added', obj({ properties: { a: str(), b: str() }, anyOf: [{ required: ['a'] }, { required: ['b'] }] }), obj({ properties: { a: str(), b: str() }, anyOf: [{ required: ['a'] }, { required: ['b'] }, { required: ['c'] }] }), 'loosen'],
  ]],
  ['allof-with-not', [
    ['flattened', { allOf: [str(), { not: { const: '' } }] }, str({ not: { const: '' } }), 'eq'],
    ['not-broadened', { allOf: [str(), { not: { const: '' } }] }, { allOf: [str(), { not: { enum: ['', ' '] } }] }, 'tighten'],
    ['not-member-removed', { allOf: [str(), { not: { const: '' } }] }, { allOf: [str()] }, 'loosen'],
  ]],
  ['oneof-with-discriminator', [
    ['branch-order', obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE] }), obj({ discriminator: DISC, oneOf: [IMAGE, VIDEO] }), 'eq'],
    ['branch-narrowed', obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE] }), obj({ discriminator: DISC, oneOf: [VIDEO, { ...IMAGE, properties: { ...IMAGE.properties, width: { type: 'integer', minimum: 1 } } }] }), 'tighten'],
    ['branch-added', obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE] }), obj({ discriminator: DISC, oneOf: [VIDEO, IMAGE, AUDIO] }), 'loosen'],
  ]],
  ['oneof-with-siblings', [
    ['branch-order', obj({ properties: { a: str(), b: str() }, oneOf: [{ required: ['a'] }, { required: ['b'] }] }), obj({ properties: { a: str(), b: str() }, oneOf: [{ required: ['b'] }, { required: ['a'] }] }), 'eq'],
    ['sibling-narrowed', obj({ properties: { a: str(), b: str() }, oneOf: [{ required: ['a'] }, { required: ['b'] }] }), obj({ properties: { a: str({ maxLength: 3 }), b: str() }, oneOf: [{ required: ['a'] }, { required: ['b'] }] }), 'tighten'],
    ['branch-narrowed', obj({ properties: { a: str(), b: str() }, oneOf: [{ required: ['a'] }, { required: ['b'] }] }), obj({ properties: { a: str(), b: str() }, oneOf: [{ required: ['a'], properties: { a: { minLength: 1 } } }, { required: ['b'] }] }), 'diff'],
  ]],
  ['allof-with-oneof', [
    ['oneof-to-anyof-under-allof-type', { allOf: [obj(), { oneOf: [untyped(VIDEO), untyped(IMAGE)] }] }, { allOf: [obj(), { anyOf: [untyped(VIDEO), untyped(IMAGE)] }] }, 'eq'],
    ['oneof-branch-removed', { allOf: [obj(), { oneOf: [untyped(VIDEO), untyped(IMAGE)] }] }, { allOf: [obj(), { oneOf: [untyped(VIDEO)] }] }, 'tighten'],
    ['oneof-branch-added', { allOf: [obj(), { oneOf: [untyped(VIDEO), untyped(IMAGE)] }] }, { allOf: [obj(), { oneOf: [untyped(VIDEO), untyped(IMAGE), untyped(AUDIO)] }] }, 'loosen'],
  ]],
  ['allof-with-anyof', [
    ['member-order', { allOf: [obj({ required: ['id'] }), { anyOf: [{ required: ['a'] }, { required: ['b'] }] }] }, { allOf: [{ anyOf: [{ required: ['b'] }, { required: ['a'] }] }, obj({ required: ['id'] })] }, 'eq'],
    ['anyof-branch-removed', { allOf: [obj({ required: ['id'] }), { anyOf: [{ required: ['a'] }, { required: ['b'] }] }] }, { allOf: [obj({ required: ['id'] }), { anyOf: [{ required: ['a'] }] }] }, 'tighten'],
    ['required-removed', { allOf: [obj({ required: ['id'] }), { anyOf: [{ required: ['a'] }, { required: ['b'] }] }] }, { allOf: [obj(), { anyOf: [{ required: ['a'] }, { required: ['b'] }] }] }, 'loosen'],
  ]],
  ['allof-with-oneof-and-discriminator', [
    ['discriminator-to-anyof-under-allof-type', { allOf: [obj(), { discriminator: DISC, oneOf: [VIDEO, IMAGE] }] }, { allOf: [obj(), { anyOf: [VIDEO, IMAGE] }] }, 'eq'],
    ['branch-narrowed', { allOf: [obj(), { discriminator: DISC, oneOf: [VIDEO, IMAGE] }] }, { allOf: [obj(), { discriminator: DISC, oneOf: [{ ...VIDEO, properties: { ...VIDEO.properties, duration: { type: 'number', maximum: 60 } } }, IMAGE] }] }, 'tighten'],
    ['object-member-removed', { allOf: [obj(), { discriminator: DISC, oneOf: [VIDEO, IMAGE] }] }, { allOf: [{ discriminator: DISC, oneOf: [VIDEO, IMAGE] }] }, 'loosen'],
  ]],
  ['allof-with-if', [
    ['member-order', { allOf: [obj(), { if: { required: ['a'] }, then: { required: ['b'] } }] }, { allOf: [{ if: { required: ['a'] }, then: { required: ['b'] } }, obj()] }, 'eq'],
    ['then-narrowed', { allOf: [obj(), { if: { required: ['a'] }, then: { required: ['b'] } }] }, { allOf: [obj(), { if: { required: ['a'] }, then: { required: ['b', 'c'] } }] }, 'tighten'],
    ['if-member-removed', { allOf: [obj(), { if: { required: ['a'] }, then: { required: ['b'] } }] }, { allOf: [obj()] }, 'loosen'],
  ]],
  ['oneof-in-allof-with-sibling-not', [
    ['not-subtracts-branch', obj({ allOf: [{ oneOf: [VIDEO, IMAGE, AUDIO] }, { not: AUDIO }] }), obj({ oneOf: [VIDEO, IMAGE] }), 'eq'],
    ['not-operand-broadened', obj({ allOf: [{ oneOf: [VIDEO, IMAGE, AUDIO] }, { not: AUDIO }] }), obj({ allOf: [{ oneOf: [VIDEO, IMAGE, AUDIO] }, { not: { anyOf: [AUDIO, IMAGE] } }] }), 'tighten'],
    ['not-removed', obj({ allOf: [{ oneOf: [VIDEO, IMAGE, AUDIO] }, { not: AUDIO }] }), obj({ allOf: [{ oneOf: [VIDEO, IMAGE, AUDIO] }] }), 'loosen'],
  ]],
  ['if-then-else-in-anyof', [
    ['branch-order', { anyOf: [{ type: 'null' }, { if: str(), then: { minLength: 1 }, else: { type: 'integer' } }] }, { anyOf: [{ if: str(), then: { minLength: 1 }, else: { type: 'integer' } }, { type: 'null' }] }, 'eq'],
    ['else-narrowed', { anyOf: [{ type: 'null' }, { if: str(), then: { minLength: 1 }, else: { type: 'integer' } }] }, { anyOf: [{ type: 'null' }, { if: str(), then: { minLength: 1 }, else: { type: 'integer', minimum: 0 } }] }, 'tighten'],
    ['then-widened', { anyOf: [{ type: 'null' }, { if: str(), then: { minLength: 2 }, else: { type: 'integer' } }] }, { anyOf: [{ type: 'null' }, { if: str(), then: { minLength: 1 }, else: { type: 'integer' } }] }, 'loosen'],
  ]],
];

/** Multi-file reference pairs: [name, baseFiles, headFiles, intent, note]. Root is a.json. */
const PRICE = obj({ properties: { amount: { type: 'number', minimum: 0 }, currency: pat('^[A-Z]{3}$') }, required: ['amount', 'currency'], additionalProperties: false });
const NODE = obj({ properties: { v: { type: 'integer' }, child: { $ref: '#/definitions/n' } } });
const REFERENCES = [
  ['extract-to-file', { 'a.json': obj({ properties: { price: PRICE } }) }, { 'a.json': obj({ properties: { price: { $ref: '/schemas/core/price.json', description: 'Order price.' } } }), 'core/price.json': PRICE }, 'eq', 'A subschema extracted to its own file and referenced with $ref, with a description beside the $ref.'],
  ['inline-from-file', { 'a.json': obj({ properties: { price: { $ref: 'core/price.json' } } }), 'core/price.json': PRICE }, { 'a.json': obj({ properties: { price: PRICE } }) }, 'eq', 'A $ref to another file replaced by the target inlined.'],
  ['definition-extracted-to-file', { 'a.json': { ...obj({ properties: { price: { $ref: '#/definitions/price' } } }), definitions: { price: PRICE } } }, { 'a.json': obj({ properties: { price: { $ref: 'price.json' } } }), 'price.json': PRICE }, 'eq', 'A local definition moved to its own file.'],
  ['ref-spelling', { 'a.json': obj({ properties: { p: { $ref: 'core/price.json' } } }), 'core/price.json': PRICE }, { 'a.json': obj({ properties: { p: { $ref: '/schemas/core/price.json' } } }), 'core/price.json': PRICE }, 'eq', 'A relative $ref respelled as an $id-absolute one.'],
  ['ref-chain-alias', { 'a.json': obj({ properties: { p: { $ref: 'b.json' } } }), 'b.json': PRICE }, { 'a.json': obj({ properties: { p: { $ref: 'c.json' } } }), 'b.json': PRICE, 'c.json': { $ref: 'b.json' } }, 'eq', 'A $ref through an alias file that is only a $ref.'],
  ['ref-to-other-file-definition', { 'a.json': obj({ properties: { c: { $ref: 'defs.json#/definitions/code' } } }), 'defs.json': { definitions: { code: pat('^[A-Z]{2}$') } } }, { 'a.json': obj({ properties: { c: { $ref: 'code.json' } } }), 'code.json': pat('^[A-Z]{2}$') }, 'eq', 'A $ref into another file\'s definitions replaced by a $ref to an extracted file.'],
  ['ref-sibling-on-file-ref', { 'a.json': obj({ properties: { c: { $ref: 'b.json', maxLength: 3 } } }), 'b.json': str() }, { 'a.json': obj({ properties: { c: str({ maxLength: 3 }) } }) }, 'eq', 'A $ref to another file with a sibling keyword, inlined with the sibling merged.'],
  ['ref-sibling-on-file-ref-dropped', { 'a.json': obj({ properties: { c: { $ref: 'b.json', maxLength: 3 } } }), 'b.json': str() }, { 'a.json': obj({ properties: { c: { $ref: 'b.json' } } }), 'b.json': str() }, 'diff', 'The sibling of a $ref to another file removed (Ajv 8 applies $ref siblings in draft-07).'],
  ['target-file-tightened', { 'a.json': obj({ properties: { c: { $ref: 'b.json' } } }), 'b.json': str({ maxLength: 10 }) }, { 'a.json': obj({ properties: { c: { $ref: 'b.json' } } }), 'b.json': str({ maxLength: 9 }) }, 'diff', 'The referenced file tightened, the referencing root unchanged.'],
  ['target-file-loosened', { 'a.json': obj({ properties: { c: { $ref: 'b.json' } } }), 'b.json': str({ maxLength: 9 }) }, { 'a.json': obj({ properties: { c: { $ref: 'b.json' } } }), 'b.json': str({ maxLength: 10 }) }, 'diff', 'The referenced file loosened, the referencing root unchanged.'],
  ['ref-retargeted', { 'a.json': obj({ properties: { c: { $ref: 'b.json' } } }), 'b.json': str({ maxLength: 9 }), 'c.json': str({ maxLength: 8 }) }, { 'a.json': obj({ properties: { c: { $ref: 'c.json' } } }), 'b.json': str({ maxLength: 9 }), 'c.json': str({ maxLength: 8 }) }, 'diff', 'A $ref pointed at a different file.'],
  ['same-ref-string-different-files', { 'a.json': obj({ properties: { c: { $ref: 'x/common.json' } } }), 'x/common.json': str() }, { 'a.json': obj({ properties: { c: { $ref: 'x/common.json' } } }), 'x/common.json': { type: 'number' } }, 'diff', 'Both sides spell the $ref the same way, but the files differ.'],
  ['recursive-unrolled-once', { 'a.json': { definitions: { n: NODE }, $ref: '#/definitions/n' } }, { 'a.json': { ...NODE, definitions: { n: NODE } } }, 'eq', 'A recursive definition unrolled one level at the root.'],
  ['recursive-root-ref', { 'a.json': { definitions: { n: NODE }, $ref: '#/definitions/n' } }, { 'a.json': obj({ properties: { v: { type: 'integer' }, child: { $ref: '#' } } }) }, 'eq', 'Recursion through a local definition respelled as recursion through the root.'],
  ['recursive-across-files', { 'a.json': obj({ properties: { v: { type: 'integer' }, child: { $ref: 'b.json' } } }), 'b.json': obj({ properties: { v: { type: 'integer' }, child: { $ref: 'a.json' } } }) }, { 'a.json': obj({ properties: { v: { type: 'integer' }, child: { $ref: '#' } } }) }, 'eq', 'A two-file cycle replaced by a one-file self-reference.'],
  ['recursive-extracted', { 'a.json': { definitions: { n: NODE }, $ref: '#/definitions/n' } }, { 'a.json': { $ref: 'node.json' }, 'node.json': obj({ properties: { v: { type: 'integer' }, child: { $ref: 'node.json' } } }) }, 'eq', 'A recursive definition extracted to its own file.'],
  ['cycle-entered-elsewhere', { 'a.json': { definitions: { A: obj({ properties: { x: { $ref: '#/definitions/B' } } }), B: obj({ properties: { y: { $ref: '#/definitions/A' } } }) }, $ref: '#/definitions/A' } }, { 'a.json': obj({ properties: { x: obj({ properties: { y: { $ref: '#' } } }) } }) }, 'eq', 'A two-definition cycle rewritten as one cycle through the root.'],
  ['recursive-tightened-one-level-down', { 'a.json': { definitions: { n: NODE }, $ref: '#/definitions/n' } }, { 'a.json': { definitions: { n: NODE, m: obj({ properties: { v: { type: 'integer', maximum: 9 }, child: { $ref: '#/definitions/n' } } }) }, ...obj({ properties: { v: { type: 'integer' }, child: { $ref: '#/definitions/m' } } }) } }, 'diff', 'A recursive schema tightened only at the second level.'],
  ['recursive-tightened-everywhere', { 'a.json': { definitions: { n: NODE }, $ref: '#/definitions/n' } }, { 'a.json': { definitions: { n: obj({ properties: { v: { type: 'integer', minimum: 0 }, child: { $ref: '#/definitions/n' } } }) }, $ref: '#/definitions/n' } }, 'diff', 'A recursive schema tightened at every level.'],
  ['recursion-cut-at-depth-two', { 'a.json': { definitions: { n: NODE }, $ref: '#/definitions/n' } }, { 'a.json': obj({ properties: { v: { type: 'integer' }, child: obj({ properties: { v: { type: 'integer' }, child: false } }) } }) }, 'diff', 'A recursion replaced by two unrolled levels and no deeper nesting.'],
];

module.exports = { CONTEXTS, ALL_CONTEXTS, MISS_CONTEXTS, KEYWORD_CONTEXTS, SNIPPETS, KEYWORDS, OPAQUE, NESTINGS, REFERENCES };
