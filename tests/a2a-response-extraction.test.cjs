/**
 * Validates A2A response extraction test vectors.
 *
 * Tests that the extraction logic for A2A responses produces the
 * expected AdCP data from Task objects and TaskStatusUpdateEvents.
 * Client libraries should also validate against these vectors.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'a2a-response-extraction.json');
const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

const FINAL_STATES = ['completed', 'failed', 'canceled', 'rejected'];
const INTERIM_STATES = ['working', 'submitted', 'input-required', 'auth-required'];

/**
 * A2A 1.0 wraps SSE frames and push-notification payloads in a StreamResponse
 * oneof: { task }, { message }, { statusUpdate }, { artifactUpdate }.
 * Unwrap to the inner object; bare objects (v0.3, or non-streaming `tasks/get`
 * responses in 1.0) pass through unchanged.
 */
const ENVELOPE_KEYS = ['task', 'message', 'statusUpdate', 'artifactUpdate'];

function unwrapStreamEnvelope(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return input;
  const keys = Object.keys(input);
  if (keys.length !== 1 || !ENVELOPE_KEYS.includes(keys[0])) return input;
  const inner = input[keys[0]];
  // Inner value must be a non-null, non-array object.
  if (inner == null || typeof inner !== 'object' || Array.isArray(inner)) return input;
  // Reject nested envelopes — exactly-once unwrap per spec §Extraction Algorithm step 0.
  const innerKeys = Object.keys(inner);
  if (innerKeys.some((k) => ENVELOPE_KEYS.includes(k))) return null;
  return inner;
}

/**
 * Normalize an A2A task state to the canonical lowercase form.
 * Accepts both A2A 1.0 ("TASK_STATE_COMPLETED") and v0.3 ("completed") wire values.
 */
function normalizeState(state) {
  if (typeof state !== 'string') return null;
  return state.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-');
}

/**
 * Test whether a Part is a DataPart. Field presence is authoritative:
 * A2A 1.0 Parts carry no `kind`, v0.3 Parts carry `kind: "data"`. Both set `data`.
 */
function isDataPart(p) {
  return p != null
    && p.data != null
    && typeof p.data === 'object'
    && !Array.isArray(p.data);
}

/**
 * Extract the last DataPart with non-null data from an array of parts.
 */
function lastDataPart(parts) {
  if (!Array.isArray(parts)) return null;
  const dataParts = parts.filter(isDataPart);
  return dataParts.length > 0 ? dataParts[dataParts.length - 1] : null;
}

/**
 * Extract the first DataPart with non-null data from an array of parts.
 */
function firstDataPart(parts) {
  if (!Array.isArray(parts)) return null;
  return parts.find(isDataPart) || null;
}

/**
 * Detect framework wrapper objects.
 * Returns true if the payload is wrapped in { response: {...} } — a single key
 * `response` whose value is a non-null, non-array object. `{ response: null }`
 * and `{ response: [] }` are NOT wrappers — they're legitimate single-field payloads.
 */
function isWrapped(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1
    && keys[0] === 'response'
    && data.response !== null
    && typeof data.response === 'object'
    && !Array.isArray(data.response);
}

/**
 * Reference extraction implementation matching the spec.
 *
 * Extracts AdCP response data from an A2A Task or TaskStatusUpdateEvent.
 * Returns the extracted data, or null if no DataPart is found.
 * Throws if a wrapper object is detected (server-side bug).
 */
function extractAdcpResponseFromA2A(input) {
  const task = unwrapStreamEnvelope(input);
  if (task == null) return null;  // nested envelope rejected
  const state = normalizeState(task?.status?.state);
  if (!state) return null;

  // Final states: extract from artifacts[0].parts[] (last DataPart)
  if (FINAL_STATES.includes(state)) {
    const artifact = task.artifacts?.[0];
    if (artifact?.parts) {
      const part = lastDataPart(artifact.parts);
      if (part) {
        if (isWrapped(part.data)) {
          throw new Error(
            'Invalid response format: DataPart contains wrapper object. ' +
            'Expected direct AdCP payload but received {response: {...}}. ' +
            'This is a server-side bug that must be fixed.'
          );
        }
        return part.data;
      }
    }
    // Fallback: check status.message.parts for final states too
    const msgPart = firstDataPart(task.status?.message?.parts);
    return msgPart?.data ?? null;
  }

  // Interim states: extract from status.message.parts[] (first DataPart)
  if (INTERIM_STATES.includes(state)) {
    const msgPart = firstDataPart(task.status?.message?.parts);
    return msgPart?.data ?? null;
  }

  return null;
}

describe('A2A response extraction test vectors', () => {
  it('should have a valid structure', () => {
    assert.equal(typeof data.version, 'number');
    assert.ok(Array.isArray(data.vectors));
    assert.ok(data.vectors.length > 0, 'must have at least one vector');

    for (const vector of data.vectors) {
      assert.ok(vector.id, 'each vector must have an id');
      assert.ok(vector.description, 'each vector must have a description');
      assert.ok(vector.status, 'each vector must have a status');
      assert.ok(vector.response, 'each vector must have a response');
      assert.ok('expected_data' in vector, 'each vector must have expected_data (can be null)');
    }
  });

  for (const vector of data.vectors) {
    it(`should extract correctly: ${vector.description} [${vector.id}]`, () => {
      if (vector.expected_error_type === 'wrapper_detected') {
        assert.throws(
          () => extractAdcpResponseFromA2A(vector.response),
          /wrapper/i,
          `Expected wrapper detection error for ${vector.id}`
        );
        return;
      }

      const extracted = extractAdcpResponseFromA2A(vector.response);

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

  it('should cover all status types', () => {
    const statuses = new Set(data.vectors.map(v => v.status));
    assert.ok(statuses.has('completed'), 'must have completed vector');
    assert.ok(statuses.has('failed'), 'must have failed vector');
    assert.ok(statuses.has('working'), 'must have working vector');
    assert.ok(statuses.has('input-required'), 'must have input-required vector');
    assert.ok(statuses.has('submitted'), 'must have submitted vector');
    assert.ok(statuses.has('canceled'), 'must have canceled vector');
    assert.ok(statuses.has('rejected'), 'must have rejected vector (1.0)');
    assert.ok(statuses.has('auth-required'), 'must have auth-required vector (1.0)');
  });

  it('should cover both extraction paths', () => {
    const paths = new Set(data.vectors.map(v => v.path));
    assert.ok(paths.has('artifact'), 'must have artifact path vector');
    assert.ok(paths.has('status_message'), 'must have status_message path vector');
  });

  it('should have null-extraction vectors', () => {
    const nullVectors = data.vectors.filter(
      v => v.expected_data === null && !v.expected_error_type
    );
    assert.ok(nullVectors.length >= 2,
      `must have at least 2 null-extraction vectors, got ${nullVectors.length}`);
  });

  it('should have wrapper detection vector', () => {
    const wrapperVectors = data.vectors.filter(v => v.expected_error_type === 'wrapper_detected');
    assert.ok(wrapperVectors.length >= 1, 'must have at least 1 wrapper detection vector');
  });
});

describe('Validation and safety', () => {
  it('should use last DataPart as authoritative for final states', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'completed' },
      artifacts: [{
        parts: [
          { kind: 'data', data: { progress: 50 } },
          { kind: 'data', data: { products: [{ product_id: 'final' }] } }
        ]
      }]
    });
    assert.deepStrictEqual(result, { products: [{ product_id: 'final' }] });
  });

  it('should use first DataPart for interim states', () => {
    const result = extractAdcpResponseFromA2A({
      status: {
        state: 'working',
        message: {
          role: 'agent',
          parts: [
            { kind: 'data', data: { percentage: 25 } },
            { kind: 'data', data: { percentage: 75 } }
          ]
        }
      }
    });
    assert.deepStrictEqual(result, { percentage: 25 });
  });

  it('should skip DataParts with null data', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'completed' },
      artifacts: [{
        parts: [
          { kind: 'data', data: null },
          { kind: 'data', data: { products: [] } }
        ]
      }]
    });
    assert.deepStrictEqual(result, { products: [] });
  });

  it('should throw on wrapper detection', () => {
    assert.throws(
      () => extractAdcpResponseFromA2A({
        status: { state: 'completed' },
        artifacts: [{
          parts: [
            { kind: 'data', data: { response: { products: [] } } }
          ]
        }]
      }),
      /wrapper/i
    );
  });

  it('should NOT throw on data that happens to have a response key among others', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'completed' },
      artifacts: [{
        parts: [
          { kind: 'data', data: { response: { products: [] }, status: 'completed' } }
        ]
      }]
    });
    assert.ok(result !== null, 'should extract when response is not the only key');
  });

  it('should return null for unknown status', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'unknown_future_status' },
      artifacts: [{
        parts: [{ kind: 'data', data: { foo: 'bar' } }]
      }]
    });
    assert.equal(result, null);
  });

  it('should return null when no status present', () => {
    const result = extractAdcpResponseFromA2A({});
    assert.equal(result, null);
  });

  it('should fall back to status.message.parts when completed but no artifacts', () => {
    const result = extractAdcpResponseFromA2A({
      status: {
        state: 'completed',
        message: {
          role: 'agent',
          parts: [{ kind: 'data', data: { products: [] } }]
        }
      }
    });
    assert.deepStrictEqual(result, { products: [] });
  });

  it('should not allow prototype pollution', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'completed' },
      artifacts: [{
        parts: [{
          kind: 'data',
          data: {
            products: [],
            __proto__: { isAdmin: true }
          }
        }]
      }]
    });
    assert.ok(result !== null);
    assert.equal(({}).isAdmin, undefined, '__proto__ must not pollute Object prototype');
  });

  it('should handle artifacts with no parts array', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'empty' }]
    });
    assert.equal(result, null);
  });

  it('should handle status.message with no parts array', () => {
    const result = extractAdcpResponseFromA2A({
      status: {
        state: 'working',
        message: { role: 'agent' }
      }
    });
    assert.equal(result, null);
  });
});

describe('A2A 1.0 wire-format compatibility', () => {
  it('should normalize TASK_STATE_COMPLETED to completed', () => {
    assert.equal(normalizeState('TASK_STATE_COMPLETED'), 'completed');
    assert.equal(normalizeState('TASK_STATE_INPUT_REQUIRED'), 'input-required');
    assert.equal(normalizeState('TASK_STATE_WORKING'), 'working');
    assert.equal(normalizeState('TASK_STATE_CANCELED'), 'canceled');
    assert.equal(normalizeState('TASK_STATE_SUBMITTED'), 'submitted');
    assert.equal(normalizeState('TASK_STATE_FAILED'), 'failed');
  });

  it('should pass v0.3 lowercase state values through unchanged', () => {
    assert.equal(normalizeState('completed'), 'completed');
    assert.equal(normalizeState('input-required'), 'input-required');
    assert.equal(normalizeState('working'), 'working');
  });

  it('should extract from 1.0 Part without kind discriminator', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{
        parts: [
          { text: 'Done' },
          { data: { products: [{ product_id: 'p1' }] } }
        ]
      }]
    });
    assert.deepStrictEqual(result, { products: [{ product_id: 'p1' }] });
  });

  it('should extract from v0.3 Part with kind discriminator (backward compat)', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'completed' },
      artifacts: [{
        parts: [
          { kind: 'text', text: 'Done' },
          { kind: 'data', data: { products: [{ product_id: 'p1' }] } }
        ]
      }]
    });
    assert.deepStrictEqual(result, { products: [{ product_id: 'p1' }] });
  });

  it('should extract from mixed 1.0 and v0.3 Parts in same artifact', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{
        parts: [
          { kind: 'text', text: 'Legacy text part' },
          { data: { products: [{ product_id: 'new' }] } }
        ]
      }]
    });
    assert.deepStrictEqual(result, { products: [{ product_id: 'new' }] });
  });

  it('should reject wrapper in 1.0 Parts without kind', () => {
    assert.throws(
      () => extractAdcpResponseFromA2A({
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{
          parts: [
            { data: { response: { products: [] } } }
          ]
        }]
      }),
      /wrapper/i
    );
  });

  it('should return null for unknown TASK_STATE_* value', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'TASK_STATE_UNKNOWN_FUTURE' },
      artifacts: [{ parts: [{ data: { foo: 'bar' } }] }]
    });
    assert.equal(result, null);
  });
});

describe('A2A 1.0 StreamResponse envelope unwrapping', () => {
  it('should unwrap { statusUpdate: ... } for interim states', () => {
    const result = extractAdcpResponseFromA2A({
      statusUpdate: {
        taskId: 'task_wrap_1',
        contextId: 'ctx_wrap_1',
        status: {
          state: 'TASK_STATE_WORKING',
          message: {
            role: 'ROLE_AGENT',
            parts: [
              { text: 'Processing' },
              { data: { percentage: 60 } }
            ]
          }
        }
      }
    });
    assert.deepStrictEqual(result, { percentage: 60 });
  });

  it('should unwrap { artifactUpdate: ... } but return null when state is absent', () => {
    // artifactUpdate events carry artifact data but no task status; extractor
    // returns null (they're delta events, not placement-authoritative).
    const result = extractAdcpResponseFromA2A({
      artifactUpdate: {
        taskId: 'task_wrap_2',
        artifact: {
          artifactId: 'a1',
          parts: [{ data: { partial: true } }]
        }
      }
    });
    assert.equal(result, null);
  });

  it('should unwrap { task: ... } for final states (push notification payload)', () => {
    const result = extractAdcpResponseFromA2A({
      task: {
        id: 'task_wrap_3',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{
          parts: [
            { text: 'Done' },
            { data: { products: [{ product_id: 'wrapped' }] } }
          ]
        }]
      }
    });
    assert.deepStrictEqual(result, { products: [{ product_id: 'wrapped' }] });
  });

  it('should leave bare Task objects alone (non-streaming tasks/get response)', () => {
    const result = extractAdcpResponseFromA2A({
      id: 'task_bare',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ parts: [{ data: { ok: true } }] }]
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  it('should NOT unwrap objects with multiple top-level keys', () => {
    // A bare Task with only { task: ..., foo: ... } is not an envelope — don't unwrap.
    const result = extractAdcpResponseFromA2A({
      id: 'task_not_env',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ parts: [{ data: { ok: true } }] }],
      contextId: 'ctx'
    });
    assert.deepStrictEqual(result, { ok: true });
  });
});

describe('A2A 1.0 new task states', () => {
  it('should extract adcp_error from TASK_STATE_REJECTED artifacts (terminal)', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'TASK_STATE_REJECTED' },
      artifacts: [{
        parts: [
          { text: 'Request rejected by policy' },
          { data: { adcp_error: { code: 'POLICY_VIOLATION', message: 'Budget exceeds tier limit' } } }
        ]
      }]
    });
    assert.deepStrictEqual(result, {
      adcp_error: { code: 'POLICY_VIOLATION', message: 'Budget exceeds tier limit' }
    });
  });

  it('should extract auth data from TASK_STATE_AUTH_REQUIRED status.message (interim)', () => {
    const result = extractAdcpResponseFromA2A({
      status: {
        state: 'TASK_STATE_AUTH_REQUIRED',
        message: {
          role: 'ROLE_AGENT',
          parts: [
            { text: 'Re-authentication required to access Peer39 data' },
            { data: { auth_scheme: 'oauth2', challenge_url: 'https://auth.example/challenge' } }
          ]
        }
      }
    });
    assert.deepStrictEqual(result, {
      auth_scheme: 'oauth2',
      challenge_url: 'https://auth.example/challenge'
    });
  });

  it('should normalize TASK_STATE_REJECTED and TASK_STATE_AUTH_REQUIRED', () => {
    assert.equal(normalizeState('TASK_STATE_REJECTED'), 'rejected');
    assert.equal(normalizeState('TASK_STATE_AUTH_REQUIRED'), 'auth-required');
  });
});

describe('A2A 1.0 safety hardening', () => {
  it('should reject nested { task: { task: ... } } envelopes (return null)', () => {
    const result = extractAdcpResponseFromA2A({
      task: {
        task: {
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ parts: [{ data: { smuggled: true } }] }]
        }
      }
    });
    assert.equal(result, null);
  });

  it('should reject envelopes with array inner value', () => {
    const result = extractAdcpResponseFromA2A({ task: [] });
    assert.equal(result, null);
  });

  it('should reject envelopes with null inner value', () => {
    const result = extractAdcpResponseFromA2A({ task: null });
    assert.equal(result, null);
  });

  it('should not treat { response: null } as a wrapper', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ parts: [{ data: { response: null } }] }]
    });
    assert.deepStrictEqual(result, { response: null });
  });

  it('should not treat { response: [] } as a wrapper', () => {
    const result = extractAdcpResponseFromA2A({
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ parts: [{ data: { response: [] } }] }]
    });
    assert.deepStrictEqual(result, { response: [] });
  });

  it('should still reject { response: {...} } single-key object wrappers', () => {
    assert.throws(
      () => extractAdcpResponseFromA2A({
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ parts: [{ data: { response: { products: [] } } }] }]
      }),
      /wrapper/i
    );
  });

  it('should require exact-match normalized state (not collapse extra separators)', () => {
    // TASK_STATE_INPUT__REQUIRED (double underscore) normalizes to 'input--required' — not allowlisted.
    const result = extractAdcpResponseFromA2A({
      status: { state: 'TASK_STATE_INPUT__REQUIRED' },
      status: {
        state: 'TASK_STATE_INPUT__REQUIRED',
        message: { role: 'ROLE_AGENT', parts: [{ data: { foo: 'bar' } }] }
      }
    });
    assert.equal(result, null);
  });
});
