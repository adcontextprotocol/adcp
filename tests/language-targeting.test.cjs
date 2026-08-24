const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  return ajv.compileAsync(schema);
}

describe('BCP 47 language targeting', () => {
  let validateTargeting;
  let validateCapability;

  before(async () => {
    const capabilityResponse = readSchema('/schemas/protocol/get-adcp-capabilities-response.json');
    const languageCapability = capabilityResponse
      .properties.media_buy.properties.execution.properties.targeting.properties.language;

    [validateTargeting, validateCapability] = await Promise.all([
      compile(readSchema('/schemas/core/targeting.json')),
      compile(languageCapability),
    ]);
  });

  it('accepts canonical regional and script language ranges in targeting', () => {
    assert.equal(validateTargeting({ language: ['en', 'fr-CA', 'zh-Hant-TW'] }), true, JSON.stringify(validateTargeting.errors));
  });

  it('rejects non-canonical language-tag spellings', () => {
    assert.equal(validateTargeting({ language: ['fr-ca'] }), false);
    assert.equal(validateTargeting({ language: ['FR-CA'] }), false);
    assert.equal(validateTargeting({ language: ['fr_CA'] }), false);
  });

  it('keeps legacy boolean capabilities wire-valid', () => {
    assert.equal(validateCapability(true), true, JSON.stringify(validateCapability.errors));
    assert.equal(validateCapability(false), true, JSON.stringify(validateCapability.errors));
  });

  it('accepts structured capabilities without over-tightening the age-restriction pattern', () => {
    assert.equal(validateCapability({ supported: true }), true, JSON.stringify(validateCapability.errors));
    assert.equal(validateCapability({ supported_languages: ['en', 'fr-CA'] }), true, JSON.stringify(validateCapability.errors));
    assert.equal(validateCapability({}), true, JSON.stringify(validateCapability.errors));
    assert.equal(validateCapability({ supported: true, extension_field: 'allowed' }), true, JSON.stringify(validateCapability.errors));
  });

  it('rejects invalid structured capability language tags', () => {
    assert.equal(validateCapability({ supported: true, supported_languages: ['fr-ca'] }), false);
    assert.equal(validateCapability({ supported: true, supported_languages: ['fr_CA'] }), false);
  });
});
