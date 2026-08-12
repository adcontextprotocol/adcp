#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildUpdatedDispositionRegistry,
  lintLanguageTagRefs,
  validateDispositionRegistry,
} = require('../scripts/lint-language-tag-refs.cjs');

const ROOT = path.resolve(__dirname, '..');

function writeJson(root, relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function withFixture(files, entries, callback, { includeLocaleTag = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'language-tag-refs-'));
  const schemasDir = path.join(tmp, 'schemas');
  const dispositionsPath = path.join(tmp, 'dispositions.json');
  try {
    if (includeLocaleTag) {
      writeJson(schemasDir, 'core/locale-tag.json', {
        $id: '/schemas/core/locale-tag.json',
        type: 'string',
        pattern: '^[a-z]{2}$',
      });
    }
    for (const [relativePath, schema] of Object.entries(files)) {
      writeJson(schemasDir, relativePath, schema);
    }
    writeJson(tmp, 'dispositions.json', { entries });
    callback(lintLanguageTagRefs({ schemasDir, dispositionsPath }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('the repository source tree passes with exact reviewed dispositions', () => {
  const result = lintLanguageTagRefs();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.candidates.length > result.findings.length);
  assert.ok(result.findings.length > 0, 'expected reviewed legacy boundaries');
});

test('accepts direct, array-item, local-wrapper, and external-wrapper refs', () => {
  withFixture({
    'core/wrapper.json': {
      $id: '/schemas/core/wrapper.json',
      definitions: {
        tag: { $ref: '/schemas/core/locale-tag.json' },
      },
      allOf: [{ $ref: '/schemas/core/locale-tag.json' }],
    },
    'example.json': {
      definitions: {
        local_tag: { allOf: [{ $ref: '/schemas/core/locale-tag.json' }] },
      },
      properties: {
        language: { $ref: '/schemas/core/locale-tag.json' },
        languages: {
          type: 'array',
          items: { $ref: '/schemas/core/locale-tag.json' },
        },
        source_locale: { $ref: '#/definitions/local_tag' },
        target_locale: { $ref: '/schemas/core/wrapper.json' },
        regional_language: { $ref: '/schemas/core/wrapper.json#/definitions/tag' },
      },
    },
  }, [], (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.findings.length, 0);
  });
});

test('accepts only supported AdCP absolute aliases and rejects hostile or versioned refs', () => {
  withFixture({
    'example.json': {
      properties: {
        interface_locale: {
          $ref: 'https://adcontextprotocol.org/schemas/latest/core/locale-tag.json',
        },
        source_language: {
          $ref: 'https://evil.example/schemas/core/locale-tag.json',
        },
        target_language: {
          $ref: '/schemas/v999/core/locale-tag.json',
        },
        query_language: {
          $ref: 'https://adcontextprotocol.org/schemas/core/locale-tag.json?other=1',
        },
        credential_language: {
          $ref: 'https://user:pass@adcontextprotocol.org/schemas/core/locale-tag.json',
        },
      },
    },
  }, [], (result) => {
    assert.deepEqual(
      result.findings.map((finding) => finding.property),
      ['credential_language', 'query_language', 'source_language', 'target_language'],
    );
    assert.ok(result.findings.every((finding) =>
      finding.reasons.some((reason) => reason.includes('unresolved $ref'))));
  });
});

test('finds compliant candidate declarations inside conditional schema branches', () => {
  withFixture({
    'example.json': {
      allOf: [{
        if: { properties: { kind: { const: 'localized' } } },
        then: {
          properties: {
            language: { $ref: '/schemas/core/locale-tag.json' },
          },
        },
      }],
    },
  }, [], (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.candidates.map((candidate) => candidate.name), ['language']);
  });
});

test('ignores non-string structured containers and boolean capability flags', () => {
  withFixture({
    'core/policy.json': {
      type: 'object',
      properties: {
        accepted_ranges: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    'example.json': {
      properties: {
        locale_policy: { $ref: '/schemas/core/policy.json' },
        locale_fallbacks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { target_id: { type: 'string' } },
            additionalProperties: false,
          },
        },
        language: { type: 'boolean' },
      },
    },
  }, [], (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.findings.length, 0);
  });
});

test('rejects a mixed anyOf arm that can produce an unconstrained string', () => {
  withFixture({
    'example.json': {
      properties: {
        language: {
          anyOf: [
            { $ref: '/schemas/core/locale-tag.json' },
            { type: 'string' },
            { type: 'null' },
          ],
        },
      },
    },
  }, [], (result) => {
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].reasons.join('\n'), /anyOf\[1\].*bare string/);
    assert.ok(result.errors.some((error) => error.includes('undispositioned finding')));
  });
});

test('rejects omitted types, boolean true, unconstrained arrays, and bare conditional arms', () => {
  withFixture({
    'example.json': {
      properties: {
        language: { description: 'Unconstrained BCP 47 value' },
        source_language: {
          anyOf: [
            { $ref: '/schemas/core/locale-tag.json' },
            {},
          ],
        },
        target_language: {
          if: { pattern: '^en' },
          then: { $ref: '/schemas/core/locale-tag.json' },
          else: { type: 'string' },
        },
        free_languages: { type: 'array' },
        permissive_languages: { type: 'array', items: {} },
        permissive_locale: true,
        disabled_locale: false,
      },
    },
  }, [], (result) => {
    assert.deepEqual(
      result.findings.map((finding) => finding.property),
      [
        'disabled_locale',
        'free_languages',
        'language',
        'permissive_languages',
        'permissive_locale',
        'source_language',
        'target_language',
      ].filter((name) => name !== 'disabled_locale').sort(),
    );
    assert.equal(result.findings.some((finding) => finding.property === 'disabled_locale'), false);
    assert.match(
      result.findings.find((finding) => finding.property === 'target_language').reasons.join('\n'),
      /else:.*bare string/,
    );
  });
});

test('accepts canonical array and locale-keyed map alternatives with null arms', () => {
  withFixture({
    'example.json': {
      properties: {
        languages: {
          anyOf: [
            {
              type: 'array',
              items: { $ref: '/schemas/core/locale-tag.json' },
            },
            { type: 'null' },
          ],
        },
        locale_names: {
          oneOf: [
            {
              type: 'object',
              propertyNames: { $ref: '/schemas/core/locale-tag.json' },
              additionalProperties: { type: 'string' },
            },
            { type: 'null' },
          ],
        },
      },
    },
  }, [], (result) => assert.equal(result.ok, true, result.errors.join('\n')));
});

test('requires tuple arrays to close or constrain additionalItems', () => {
  const tagRef = { $ref: '/schemas/core/locale-tag.json' };
  withFixture({
    'example.json': {
      properties: {
        bad_languages: { type: 'array', items: [tagRef] },
        empty_languages: { type: 'array', items: [] },
        closed_languages: {
          type: 'array',
          items: [tagRef],
          additionalItems: false,
        },
        extended_languages: {
          type: 'array',
          items: [tagRef],
          additionalItems: tagRef,
        },
      },
    },
  }, [], (result) => {
    assert.deepEqual(
      result.findings.map((finding) => finding.property),
      ['bad_languages', 'empty_languages'],
    );
    assert.ok(result.findings.every((finding) =>
      finding.reasons.some((reason) => reason.includes('additionalItems'))));
  });
});

test('accepts an allOf intersection when one arm applies the canonical constraint', () => {
  withFixture({
    'example.json': {
      properties: {
        language: {
          allOf: [
            { type: 'string', minLength: 2 },
            { $ref: '/schemas/core/locale-tag.json' },
          ],
        },
      },
    },
  }, [], (result) => assert.equal(result.ok, true, result.errors.join('\n')));
});

test('keeps partially negated string schemas in scope', () => {
  withFixture({
    'example.json': {
      properties: {
        target_language: {
          not: { type: 'string', pattern: '^x' },
        },
        source_language: {
          not: { type: 'string' },
        },
      },
    },
  }, [], (result) => {
    assert.deepEqual(
      result.findings.map((finding) => finding.property),
      ['target_language'],
    );
  });
});

test('requires locale-keyed maps to constrain propertyNames with the primitive', () => {
  withFixture({
    'example.json': {
      properties: {
        localized_languages: {
          type: 'object',
          propertyNames: { $ref: '/schemas/core/locale-tag.json' },
          additionalProperties: { type: 'string' },
        },
        locale_names: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    },
  }, [], (result) => {
    assert.deepEqual(result.findings.map((finding) => finding.property), ['locale_names']);
    assert.match(result.findings[0].reasons[0], /propertyNames/);
  });
});

test('uses typed dispositions for legacy boundaries and deliberate name collisions', () => {
  const entries = [
    {
      path: 'example.json#/properties/language',
      disposition: 'legacy-language-boundary',
      rationale: 'Published legacy language field retained for compatibility.',
    },
    ...['locale_variant_id', 'locale_matching', 'unmatched_locale_action'].map((name) => ({
      path: `example.json#/properties/${name}`,
      disposition: 'not-a-language-tag',
      rationale: `${name} is structural protocol data, not a language tag.`,
    })),
  ];
  withFixture({
    'example.json': {
      properties: {
        language: { type: 'string' },
        locale_variant_id: { type: 'string' },
        locale_matching: { type: 'string', enum: ['basic_filtering'] },
        unmatched_locale_action: { type: 'string', enum: ['reject'] },
      },
    },
  }, entries, (result) => assert.equal(result.ok, true, result.errors.join('\n')));
});

test('does not interpret examples, defaults, or x-adcp-validation as declarations', () => {
  withFixture({
    'example.json': {
      properties: {
        title: {
          type: 'string',
          default: { language: 'FR-ca' },
          examples: [{ locale: 'FR-ca' }],
          'x-adcp-validation': {
            properties: { languages: { type: 'array', items: { type: 'string' } } },
          },
        },
      },
      examples: [{ language: 'FR-ca' }],
    },
  }, [], (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.candidates.length, 0);
  });
});

test('fails on stale, malformed, and duplicate disposition entries', () => {
  const validation = validateDispositionRegistry({
    entries: [
      {
        path: 'example.json#/properties/language',
        disposition: 'legacy-language-boundary',
        rationale: 'A sufficiently detailed compatibility rationale.',
      },
      {
        path: 'example.json#/properties/language',
        disposition: 'not-a-language-tag',
        rationale: 'Duplicate paths are never accepted by the registry.',
      },
      {
        path: 'not-a-pointer',
        disposition: 'TODO',
        rationale: '',
      },
      {
        path: 'example.json#/properties/bad~2escape',
        disposition: 'not-a-language-tag',
        rationale: 'Invalid RFC 6901 escaping must be rejected.',
      },
    ],
  });
  assert.ok(validation.errors.some((error) => error.includes('duplicates')));
  assert.ok(validation.errors.some((error) => error.includes('schema-relative JSON Pointer')));
  assert.ok(validation.errors.some((error) => error.includes('must be one of')));
  assert.ok(validation.errors.some((error) => error.includes('must explain')));

  withFixture({}, [{
    path: 'example.json#/properties/language',
    disposition: 'legacy-language-boundary',
    rationale: 'This field no longer exists and must be removed.',
  }], (result) => {
    assert.ok(result.errors.some((error) => error.includes('stale disposition')));
  });
});

test('fails closed when the canonical locale-tag schema is absent', () => {
  withFixture({
    'example.json': {
      properties: {
        language: { $ref: '/schemas/core/locale-tag.json' },
      },
    },
  }, [], (result) => {
    assert.ok(result.errors.some((error) => error.includes('missing canonical primitive')));
    assert.ok(result.findings.some((finding) => finding.property === 'language'));
  }, { includeLocaleTag: false });
});

test('baseline update preserves reviewed entries and adds failing TODO placeholders', () => {
  const reviewed = {
    path: 'legacy.json#/properties/language',
    disposition: 'legacy-language-boundary',
    rationale: 'Reviewed legacy boundary retained for wire compatibility.',
  };
  const updated = buildUpdatedDispositionRegistry([
    { path: reviewed.path, property: 'language', reasons: ['bare string'] },
    { path: 'new.json#/properties/locale', property: 'locale', reasons: ['bare string'] },
  ], [reviewed, {
    path: 'stale.json#/properties/language',
    disposition: 'legacy-language-boundary',
    rationale: 'Stale entry that should be dropped during an update.',
  }]);

  assert.deepEqual(updated.entries[0], reviewed);
  assert.equal(updated.entries[1].disposition, 'TODO');
  assert.equal(updated.entries.some((entry) => entry.path.startsWith('stale.json')), false);
  assert.ok(validateDispositionRegistry(updated).errors.some((error) => error.includes('must be one of')));
});

test('baseline update refuses to write without the canonical primitive or a valid registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'language-tag-update-'));
  const schemasDir = path.join(tmp, 'schemas');
  const dispositionsPath = path.join(tmp, 'dispositions.json');
  try {
    fs.mkdirSync(schemasDir, { recursive: true });
    const original = '{"entries": []}\n';
    fs.writeFileSync(dispositionsPath, original);
    const result = childProcess.spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'scripts', 'lint-language-tag-refs.cjs'),
        '--schemas',
        schemasDir,
        '--dispositions',
        dispositionsPath,
        '--update-baseline',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, ADCP_UPDATE_LANGUAGE_TAG_DISPOSITIONS: '1' },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing canonical primitive/);
    assert.equal(fs.readFileSync(dispositionsPath, 'utf8'), original);

    writeJson(schemasDir, 'core/locale-tag.json', {
      $id: '/schemas/core/locale-tag.json',
      type: 'string',
    });
    fs.writeFileSync(dispositionsPath, '{ malformed json');
    const malformed = childProcess.spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'scripts', 'lint-language-tag-refs.cjs'),
        '--schemas',
        schemasDir,
        '--dispositions',
        dispositionsPath,
        '--update-baseline',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, ADCP_UPDATE_LANGUAGE_TAG_DISPOSITIONS: '1' },
      },
    );
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /invalid disposition registry JSON/);
    assert.equal(fs.readFileSync(dispositionsPath, 'utf8'), '{ malformed json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
