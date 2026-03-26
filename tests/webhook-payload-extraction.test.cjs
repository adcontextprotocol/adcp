/**
 * Validates webhook payload extraction test vectors.
 *
 * Tests format detection (MCP vs A2A) and data extraction from webhook
 * payloads. MCP webhooks use a flat envelope with a `result` field.
 * A2A webhooks use native Task/TaskStatusUpdateEvent objects and delegate
 * to the A2A response extraction algorithm.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'webhook-payload-extraction.json');
const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

// --- A2A extraction (reused from a2a-response-extraction) ---

const FINAL_STATES = ['completed', 'failed', 'canceled'];
const INTERIM_STATES = ['working', 'submitted', 'input-required'];

function lastDataPart(parts) {
  if (!Array.isArray(parts)) return null;
  const dataParts = parts.filter(p => p.kind === 'data' && p.data != null
    && typeof p.data === 'object' && !Array.isArray(p.data));
  return dataParts.length > 0 ? dataParts[dataParts.length - 1] : null;
}

function firstDataPart(parts) {
  if (!Array.isArray(parts)) return null;
  return parts.find(p => p.kind === 'data' && p.data != null
    && typeof p.data === 'object' && !Array.isArray(p.data)) || null;
}

function extractAdcpResponseFromA2A(task) {
  const state = task.status?.state;
  if (!state) return null;

  if (FINAL_STATES.includes(state)) {
    const artifact = task.artifacts?.[0];
    if (artifact?.parts) {
      const part = lastDataPart(artifact.parts);
      if (part) {
        // Reject framework wrappers (single-key {response: {...}})
        const keys = Object.keys(part.data);
        if (keys.length === 1 && keys[0] === 'response' && typeof part.data.response === 'object') {
          throw new Error('Wrapper object detected in webhook A2A payload');
        }
        return part.data;
      }
    }
    const msgPart = firstDataPart(task.status?.message?.parts);
    return msgPart?.data ?? null;
  }

  if (INTERIM_STATES.includes(state)) {
    const msgPart = firstDataPart(task.status?.message?.parts);
    return msgPart?.data ?? null;
  }

  return null;
}

// --- Format detection ---

/**
 * Detect whether a webhook payload is MCP or A2A format.
 *
 * Primary: the buyer knows the format because it configured the transport.
 * Defensive fallback for when format is unknown:
 *   - `status.state` (object with state) → A2A
 *   - `status` (string) with `task_id` → MCP
 */
function detectWebhookFormat(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // A2A: status is an object with a state field
  if (payload.status && typeof payload.status === 'object'
      && !Array.isArray(payload.status) && payload.status.state) {
    return 'a2a';
  }

  // MCP: status is a string, task_id present
  if (typeof payload.status === 'string' && payload.task_id) {
    return 'mcp';
  }

  return null;
}

// --- Webhook extraction ---

/**
 * Extract AdCP response data from a webhook payload.
 *
 * For MCP webhooks: data is in the `result` field.
 * For A2A webhooks: delegates to A2A extraction algorithm.
 */
function extractAdcpResponseFromWebhook(payload, knownFormat) {
  const format = knownFormat || detectWebhookFormat(payload);

  if (format === 'mcp') {
    return payload.result ?? null;
  }

  if (format === 'a2a') {
    return extractAdcpResponseFromA2A(payload);
  }

  return null;
}

describe('Webhook payload extraction test vectors', () => {
  it('should have a valid structure', () => {
    assert.equal(typeof data.version, 'number');
    assert.ok(Array.isArray(data.vectors));
    assert.ok(data.vectors.length > 0, 'must have at least one vector');

    for (const vector of data.vectors) {
      assert.ok(vector.id, 'each vector must have an id');
      assert.ok(vector.description, 'each vector must have a description');
      assert.ok(vector.format, 'each vector must have a format');
      assert.ok(vector.payload, 'each vector must have a payload');
      assert.ok('expected_data' in vector, 'each vector must have expected_data (can be null)');
      assert.ok(vector.expected_format, 'each vector must have expected_format');
    }
  });

  for (const vector of data.vectors) {
    it(`should detect format correctly: ${vector.id}`, () => {
      const detected = detectWebhookFormat(vector.payload);
      assert.equal(detected, vector.expected_format,
        `Expected format ${vector.expected_format} but detected ${detected} for ${vector.id}`);
    });

    it(`should extract correctly: ${vector.description} [${vector.id}]`, () => {
      const extracted = extractAdcpResponseFromWebhook(vector.payload);

      if (vector.expected_data === null) {
        assert.equal(extracted, null,
          `Expected null but got: ${JSON.stringify(extracted)}`);
      } else {
        assert.ok(extracted !== null,
          `Expected data but extraction returned null`);
        assert.deepStrictEqual(extracted, vector.expected_data,
          `Extracted data does not match expected for ${vector.id}`);
      }
    });
  }

  it('should cover both webhook formats', () => {
    const formats = new Set(data.vectors.map(v => v.format));
    assert.ok(formats.has('mcp'), 'must have MCP webhook vector');
    assert.ok(formats.has('a2a'), 'must have A2A webhook vector');
  });

  it('should have null-extraction vectors', () => {
    const nullVectors = data.vectors.filter(v => v.expected_data === null);
    assert.ok(nullVectors.length >= 2,
      `must have at least 2 null-extraction vectors, got ${nullVectors.length}`);
  });

  it('should cover multiple statuses per format', () => {
    const mcpStatuses = new Set(
      data.vectors.filter(v => v.format === 'mcp').map(v => v.payload.status)
    );
    const a2aStatuses = new Set(
      data.vectors.filter(v => v.format === 'a2a').map(v => v.payload.status?.state)
    );
    assert.ok(mcpStatuses.size >= 3, `must have at least 3 MCP statuses, got ${mcpStatuses.size}`);
    assert.ok(a2aStatuses.size >= 3, `must have at least 3 A2A statuses, got ${a2aStatuses.size}`);
  });
});

describe('Format detection', () => {
  it('should detect MCP format from string status + task_id', () => {
    assert.equal(detectWebhookFormat({
      task_id: 'task_001',
      status: 'completed',
      result: {}
    }), 'mcp');
  });

  it('should detect A2A format from object status with state', () => {
    assert.equal(detectWebhookFormat({
      id: 'task_001',
      status: { state: 'completed' }
    }), 'a2a');
  });

  it('should return null for unrecognized format', () => {
    assert.equal(detectWebhookFormat({ foo: 'bar' }), null);
  });

  it('should return null for null payload', () => {
    assert.equal(detectWebhookFormat(null), null);
  });

  it('should return null for non-object payload', () => {
    assert.equal(detectWebhookFormat('string'), null);
  });
});

describe('Extraction with known format', () => {
  it('should extract MCP data when format is known', () => {
    const result = extractAdcpResponseFromWebhook(
      { task_id: 'task_001', status: 'completed', result: { products: [] } },
      'mcp'
    );
    assert.deepStrictEqual(result, { products: [] });
  });

  it('should extract A2A data when format is known', () => {
    const result = extractAdcpResponseFromWebhook(
      {
        id: 'task_001',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ kind: 'data', data: { products: [] } }] }]
      },
      'a2a'
    );
    assert.deepStrictEqual(result, { products: [] });
  });

  it('should return null for unknown format', () => {
    const result = extractAdcpResponseFromWebhook({ foo: 'bar' }, null);
    assert.equal(result, null);
  });
});

describe('Validation and safety', () => {
  it('should handle MCP payload with undefined result', () => {
    const result = extractAdcpResponseFromWebhook(
      { task_id: 'task_001', status: 'completed' },
      'mcp'
    );
    assert.equal(result, null);
  });

  it('should handle A2A payload with no artifacts or message', () => {
    const result = extractAdcpResponseFromWebhook(
      { id: 'task_001', status: { state: 'completed' } },
      'a2a'
    );
    assert.equal(result, null);
  });

  it('should not allow prototype pollution via MCP result', () => {
    const result = extractAdcpResponseFromWebhook(
      {
        task_id: 'task_001',
        status: 'completed',
        result: { products: [], __proto__: { isAdmin: true } }
      },
      'mcp'
    );
    assert.ok(result !== null);
    assert.equal(({}).isAdmin, undefined, '__proto__ must not pollute Object prototype');
  });
});
