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

const FINAL_STATES = ['completed', 'failed', 'canceled'];
const INTERIM_STATES = ['working', 'submitted', 'input-required'];

/**
 * Extract the last DataPart with non-null data from an array of parts.
 */
function lastDataPart(parts) {
  if (!Array.isArray(parts)) return null;
  const dataParts = parts.filter(p => p.kind === 'data' && p.data != null
    && typeof p.data === 'object' && !Array.isArray(p.data));
  return dataParts.length > 0 ? dataParts[dataParts.length - 1] : null;
}

/**
 * Extract the first DataPart with non-null data from an array of parts.
 */
function firstDataPart(parts) {
  if (!Array.isArray(parts)) return null;
  return parts.find(p => p.kind === 'data' && p.data != null
    && typeof p.data === 'object' && !Array.isArray(p.data)) || null;
}

/**
 * Detect framework wrapper objects.
 * Returns true if the payload is wrapped in { response: {...} }.
 */
function isWrapped(data) {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  return keys.length === 1 && keys[0] === 'response' && typeof data.response === 'object';
}

/**
 * Reference extraction implementation matching the spec.
 *
 * Extracts AdCP response data from an A2A Task or TaskStatusUpdateEvent.
 * Returns the extracted data, or null if no DataPart is found.
 * Throws if a wrapper object is detected (server-side bug).
 */
function extractAdcpResponseFromA2A(task) {
  const state = task.status?.state;
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
