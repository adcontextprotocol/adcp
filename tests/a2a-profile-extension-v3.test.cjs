const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'a2a-profile-extension-v3.json');
const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
const URI = 'https://adcontextprotocol.org/extensions/adcp/v3';
const schemaRoot = path.join(__dirname, '..', 'static', 'schemas', 'source');
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

function validateAdvertisement(agentCard) {
  const topLevel = agentCard?.extensions;
  const extensions = agentCard?.capabilities?.extensions;
  if (!Array.isArray(extensions)) {
    if (Array.isArray(topLevel) && topLevel.some(ext => ext?.uri === URI)) {
      return 'extension_not_under_capabilities';
    }
    return 'extension_not_advertised';
  }
  const extension = extensions.find(ext => ext?.uri === URI);
  if (!extension) return 'extension_not_advertised';
  if (extension.required !== true) return 'extension_not_required';
  if (extension.params !== undefined && (!isObject(extension.params) || Object.keys(extension.params).length > 0)) {
    return 'extension_params_not_empty';
  }
  const skillIds = new Set((agentCard.skills ?? []).map(skill => skill?.id));
  if (!skillIds.has('get_adcp_capabilities')) return 'missing_get_adcp_capabilities_skill_id';
  return null;
}

function activated(headers) {
  if (headers?.['A2A-Version'] !== '1.0') return false;
  return String(headers?.['A2A-Extensions'] ?? '')
    .split(',')
    .map(value => value.trim())
    .includes(URI);
}

function validateInvocation(vector) {
  if (!activated(vector.headers)) return 'extension_not_activated';
  if (typeof vector.message?.messageId !== 'string' || vector.message.messageId.length === 0) {
    return 'invalid_a2a_message';
  }
  if (vector.message.role !== 'ROLE_USER') return 'invalid_a2a_message';
  const parts = vector.message?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return 'invalid_a2a_message';

  for (const part of parts) {
    if (!isObject(part)) return 'invalid_a2a_message';
    const contentFields = ['text', 'raw', 'url', 'data'].filter(field => Object.hasOwn(part, field));
    if (contentFields.length !== 1) return 'invalid_a2a_message';
  }

  const dataParts = parts.filter(part => isObject(part) && Object.hasOwn(part, 'data'));
  if (dataParts.length > 1) return 'multiple_invocation_dataparts';
  if (dataParts.length !== 1) return 'invalid_invocation_shape';

  for (const part of parts) {
    if (part === dataParts[0]) continue;
    const allowedTextFields = new Set(['text', 'metadata', 'filename', 'mediaType']);
    if (!isObject(part) || typeof part.text !== 'string'
      || Object.keys(part).some(key => !allowedTextFields.has(key))) {
      return 'unsupported_part_type';
    }
  }

  const invocation = dataParts[0].data;
  if (!isObject(invocation)) return 'invalid_invocation_shape';
  const keys = Object.keys(invocation).sort();
  if (keys.length !== 2 || keys[0] !== 'input' || keys[1] !== 'skill') return 'invalid_invocation_shape';
  if (typeof invocation.skill !== 'string' || invocation.skill.length === 0 || !isObject(invocation.input)) {
    return 'invalid_invocation_shape';
  }
  return null;
}

function lastDataPart(task) {
  const parts = task?.artifacts?.[0]?.parts;
  if (!Array.isArray(parts)) return null;
  const dataParts = parts.filter(part => isObject(part?.data));
  return dataParts.at(-1) ?? null;
}

function validateResponse(vector) {
  const response = vector.response;
  if (!isObject(response) || Object.keys(response).length !== 1 || !isObject(response.task)) {
    return 'invalid_send_message_response';
  }
  const task = response.task;
  if (typeof task.id !== 'string' || task.id.length === 0 || !isObject(task.status)) {
    return 'invalid_a2a_task';
  }
  if (!Array.isArray(task.artifacts) || task.artifacts.some(artifact =>
    typeof artifact?.artifactId !== 'string' || !Array.isArray(artifact?.parts))) {
    return 'invalid_a2a_task';
  }
  const data = lastDataPart(task)?.data;
  if (!data) return 'missing_adcp_datapart';

  if (task.artifacts.some(artifact => Object.hasOwn(artifact?.metadata ?? {}, 'adcp_task_id'))) {
    return 'adcp_task_id_metadata_duplication';
  }

  if (vector.handler_return === 'submitted') {
    if (task.status?.state !== 'TASK_STATE_COMPLETED') {
      return 'submitted_handler_return_not_a2a_completed';
    }
    if (data.status !== 'submitted' || typeof data.task_id !== 'string') {
      return 'invalid_submitted_datapart';
    }
  }

  if (vector.expected_adcp_task_id !== undefined && data.task_id !== vector.expected_adcp_task_id) {
    return 'wrong_adcp_task_id';
  }
  return null;
}

describe('AdCP A2A Profile Extension v3 vectors', () => {
  it('pins the versioned extension identity', () => {
    assert.equal(vectors.version, '3.0.0');
    assert.equal(vectors.extension_uri, URI);
    assert.equal(vectors.a2a_protocol_version, '1.0');
  });

  for (const vector of vectors.advertisement_vectors) {
    it(`validates advertisement: ${vector.id}`, () => {
      const error = validateAdvertisement(vector.agent_card);
      assert.equal(error, vector.valid ? null : vector.expected_error);
    });
  }

  for (const vector of vectors.invocation_vectors) {
    it(`validates invocation: ${vector.id}`, async () => {
      const error = validateInvocation(vector);
      assert.equal(error, vector.valid ? null : vector.expected_error);
      if (vector.valid) {
        const invocation = vector.message.parts.find(part => isObject(part.data)).data;
        const schemaBySkill = {
          get_products: '/schemas/media-buy/get-products-request.json',
          get_task_status: '/schemas/protocol/get-task-status-request.json',
        };
        if (schemaBySkill[invocation.skill]) {
          const validate = await compile(schemaBySkill[invocation.skill]);
          assert.equal(validate(invocation.input), true, JSON.stringify(validate.errors));
        }
      }
    });
  }

  for (const vector of vectors.response_vectors) {
    it(`validates response: ${vector.id}`, async () => {
      const error = validateResponse(vector);
      assert.equal(error, vector.valid ? null : vector.expected_error);
      if (vector.valid && vector.handler_return === 'get_task_status') {
        const validate = await compile('/schemas/protocol/get-task-status-response.json');
        const data = lastDataPart(vector.response.task).data;
        assert.equal(validate(data), true, JSON.stringify(validate.errors));
        const terminalSchemaByTaskType = {
          create_media_buy: '/schemas/media-buy/create-media-buy-response.json',
        };
        const resultSchema = terminalSchemaByTaskType[data.task_type];
        assert.ok(resultSchema, `no terminal schema mapping for ${data.task_type}`);
        const validateResult = await compile(resultSchema);
        assert.equal(validateResult(data.result), true, JSON.stringify(validateResult.errors));
      }
    });
  }

  it('covers advertisement, activation, advisory text, submitted mapping, metadata prohibition, and polling', () => {
    const ids = new Set([
      ...vectors.advertisement_vectors,
      ...vectors.invocation_vectors,
      ...vectors.response_vectors,
    ].map(vector => vector.id));
    for (const required of [
      'agent-card-capabilities-extension',
      'agent-card-skill-name-not-id-invalid',
      'profile-not-activated-invalid',
      'missing-message-id-invalid',
      'activated-invocation-with-advisory-text',
      'input-required-continuation',
      'bare-send-message-task-invalid',
      'submitted-inside-completed-a2a-task',
      'duplicated-adcp-task-id-invalid',
      'get-task-status-poll',
      'completed-get-task-status-result',
    ]) {
      assert.ok(ids.has(required), `missing required vector ${required}`);
    }
  });
});
