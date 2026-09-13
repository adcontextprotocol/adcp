const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'a2a-profile-extension-v3-2.json');
const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
const URI = 'https://adcontextprotocol.org/extensions/adcp/v3.2';
const schemaRoot = path.join(__dirname, '..', 'static', 'schemas', 'source');
const buyerSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'call-adcp-agent', 'SKILL.md'), 'utf8');
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  discriminator: true,
  loadSchema: async (uri) => {
    if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
    return JSON.parse(fs.readFileSync(path.join(schemaRoot, uri.replace('/schemas/', '')), 'utf8'));
  },
});
addFormats(ajv);

async function compile(schemaId) {
  const existing = ajv.getSchema(schemaId);
  if (existing) return existing;
  const schema = JSON.parse(fs.readFileSync(path.join(schemaRoot, schemaId.replace('/schemas/', '')), 'utf8'));
  return ajv.compileAsync(schema);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function atJsonPointer(value, pointer) {
  return pointer.slice(1).split('/').reduce(
    (current, segment) => current?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')],
    value,
  );
}

function activated(headers) {
  if (headers?.['A2A-Version'] !== '1.0') return false;
  return String(headers?.['A2A-Extensions'] ?? '')
    .split(',')
    .map(value => value.trim())
    .includes(URI);
}

function validateAdvertisement(agentCard) {
  const extension = agentCard?.capabilities?.extensions?.find(ext => ext?.uri === URI);
  if (!extension) return 'extension_not_advertised';
  if (extension.required !== true) return 'extension_not_required';
  const skillIds = new Set((agentCard.skills ?? []).map(skill => skill?.id));
  if (!skillIds.has('get_adcp_capabilities')) return 'missing_get_adcp_capabilities_skill_id';
  return null;
}

function invocationPart(vector) {
  const dataParts = vector.message?.parts?.filter(part => Object.hasOwn(part ?? {}, 'data')) ?? [];
  if (dataParts.length !== 1) return { error: 'invalid_invocation_shape' };
  return { part: dataParts[0] };
}

function decodeJsonTextPart(part) {
  if (typeof part?.data !== 'string') return { error: 'data_not_json_text' };
  if (part.mediaType !== 'application/json') return { error: 'invalid_media_type' };
  try {
    const decoded = JSON.parse(part.data);
    if (!isObject(decoded)) return { error: 'invalid_json_text' };
    return { decoded };
  } catch {
    return { error: 'invalid_json_text' };
  }
}

function validateInvocation(vector) {
  if (!activated(vector.headers)) return { error: 'extension_not_activated' };
  const selected = invocationPart(vector);
  if (selected.error) return selected;
  const parsed = decodeJsonTextPart(selected.part);
  if (parsed.error) return parsed;
  const keys = Object.keys(parsed.decoded).sort();
  if (keys.length !== 2 || keys[0] !== 'input' || keys[1] !== 'skill') {
    return { error: 'invalid_invocation_shape' };
  }
  if (typeof parsed.decoded.skill !== 'string' || parsed.decoded.skill.length === 0 || !isObject(parsed.decoded.input)) {
    return { error: 'invalid_invocation_shape' };
  }
  return { invocation: parsed.decoded, jsonText: selected.part.data };
}

function lastResponsePart(response) {
  const parts = response?.task?.artifacts?.[0]?.parts;
  if (!Array.isArray(parts)) return null;
  return parts.filter(part => Object.hasOwn(part ?? {}, 'data')).at(-1) ?? null;
}

describe('AdCP A2A Profile Extension v3.2 vectors', () => {
  it('pins a distinct transport profile without changing the legacy v3 identity', () => {
    assert.equal(vectors.version, '3.2.0');
    assert.equal(vectors.extension_uri, URI);
    assert.equal(vectors.legacy_extension_uri, 'https://adcontextprotocol.org/extensions/adcp/v3');
    assert.notEqual(vectors.extension_uri, vectors.legacy_extension_uri);
  });

  it('ships the v3.2 JSON-text binding in the bundled buyer skill', () => {
    assert.match(buyerSkill, new RegExp(URI.replace(/[./]/g, '\\$&')));
    assert.match(buyerSkill, /JSON\.stringify\(\{ skill:/);
    assert.match(buyerSkill, /Do not accept object-valued `data` as a fallback/);
  });

  for (const vector of vectors.advertisement_vectors) {
    it(`validates advertisement: ${vector.id}`, () => {
      const error = validateAdvertisement(vector.agent_card);
      assert.equal(error, vector.valid ? null : vector.expected_error);
    });
  }

  for (const vector of vectors.invocation_vectors) {
    it(`validates invocation: ${vector.id}`, async () => {
      const result = validateInvocation(vector);
      assert.equal(result.error ?? null, vector.valid ? null : vector.expected_error);
      if (!vector.valid) return;

      assert.equal(result.invocation.skill, vector.expected_skill);
      const validate = await compile(vector.input_schema);
      assert.equal(validate(result.invocation.input), true, JSON.stringify(validate.errors));
      for (const expected of vector.expected_integer_tokens) {
        assert.equal(atJsonPointer(result.invocation.input, expected.pointer), expected.value);
        const token = result.jsonText.match(new RegExp(`"${expected.name}"\\s*:\\s*(-?(?:0|[1-9]\\d*))`))?.[1];
        assert.equal(token, expected.lexeme);
        assert.doesNotMatch(result.jsonText, new RegExp(`"${expected.name}"\\s*:\\s*-?(?:0|[1-9]\\d*)\\.0(?:\\D|$)`));
      }
    });
  }

  for (const vector of vectors.response_vectors) {
    it(`validates response: ${vector.id}`, async () => {
      const parsed = decodeJsonTextPart(lastResponsePart(vector.response));
      assert.equal(parsed.error ?? null, vector.valid ? null : vector.expected_error);
      if (!vector.valid) return;

      const validate = await compile(vector.response_schema);
      assert.equal(validate(parsed.decoded), true, JSON.stringify(validate.errors));
      const part = lastResponsePart(vector.response);
      for (const expected of vector.expected_integer_tokens) {
        assert.equal(atJsonPointer(parsed.decoded, expected.pointer), expected.value);
        const token = part.data.match(new RegExp(`"${expected.name}"\\s*:\\s*(-?(?:0|[1-9]\\d*))`))?.[1];
        assert.equal(token, expected.lexeme);
        assert.doesNotMatch(part.data, new RegExp(`"${expected.name}"\\s*:\\s*-?(?:0|[1-9]\\d*)\\.0(?:\\D|$)`));
      }
    });
  }

  it('records the protobuf widening regression and the string-arm repair', () => {
    const regression = vectors.legacy_widening_regression;
    assert.match(regression.source_adcp_json, /"revision":3}/);
    assert.match(regression.legacy_v3_protojson, /"revision":3\.0}/);
    assert.equal(JSON.parse(regression.v3_2_protojson).data, regression.source_adcp_json);
    assert.match(regression.typed_go_legacy_result, /cannot unmarshal number 3\.0/);
    assert.equal(regression.typed_go_v3_2_result, 'accepted');
  });
});
