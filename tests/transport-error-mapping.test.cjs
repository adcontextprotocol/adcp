/**
 * Validates transport error mapping test vectors.
 *
 * Tests that the extraction logic for each transport path produces the
 * expected AdCP error from the response envelope. Client libraries
 * should also validate against these vectors.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'transport-error-mapping.json');
const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

/**
 * Reference extraction implementation matching the spec.
 * Client libraries should produce identical results.
 */
function extractAdcpError(response) {
  // 1. MCP structuredContent (tool-level)
  if (response.structuredContent?.adcp_error) {
    return response.structuredContent.adcp_error;
  }

  // 2. A2A artifact DataPart
  if (response.artifacts) {
    for (const artifact of response.artifacts) {
      const dataParts = (artifact.parts || []).filter(p => p.kind === 'data');
      for (const part of dataParts) {
        if (part.data?.adcp_error) {
          return part.data.adcp_error;
        }
      }
    }
  }

  // 3. JSON-RPC error.data (transport-level)
  if (response.error?.data?.adcp_error) {
    return response.error.data.adcp_error;
  }

  // 4. Text fallback: try JSON.parse on text content
  if (response.content && Array.isArray(response.content)) {
    for (const item of response.content) {
      if (item.type === 'text' && item.text) {
        try {
          const parsed = JSON.parse(item.text);
          if (parsed.adcp_error) {
            return parsed.adcp_error;
          }
        } catch {
          // Not JSON, continue
        }
      }
    }
  }

  return null;
}

/**
 * Standard code → recovery mapping for when recovery field is absent.
 * Matches the CODE_RECOVERY table in the spec.
 */
const CODE_RECOVERY = {
  RATE_LIMITED: 'transient',
  SERVICE_UNAVAILABLE: 'transient',
  CONFLICT: 'transient',
  INVALID_REQUEST: 'correctable',
  AUTH_REQUIRED: 'correctable',
  POLICY_VIOLATION: 'correctable',
  PRODUCT_NOT_FOUND: 'correctable',
  PRODUCT_UNAVAILABLE: 'correctable',
  PROPOSAL_EXPIRED: 'correctable',
  BUDGET_TOO_LOW: 'correctable',
  CREATIVE_REJECTED: 'correctable',
  UNSUPPORTED_FEATURE: 'correctable',
  AUDIENCE_TOO_SMALL: 'correctable',
  ACCOUNT_SETUP_REQUIRED: 'correctable',
  ACCOUNT_AMBIGUOUS: 'correctable',
  COMPLIANCE_UNSATISFIED: 'correctable',
  ACCOUNT_NOT_FOUND: 'terminal',
  ACCOUNT_PAYMENT_REQUIRED: 'terminal',
  ACCOUNT_SUSPENDED: 'terminal',
  BUDGET_EXHAUSTED: 'terminal',
};

/**
 * Get effective recovery classification, falling back to code-based
 * mapping when recovery field is absent.
 */
function getRecovery(error) {
  if (error.recovery) return error.recovery;
  return CODE_RECOVERY[error.code] || 'terminal';
}

/**
 * Determine expected action from recovery classification.
 */
function getExpectedAction(error) {
  if (!error) return 'generic_error';
  switch (getRecovery(error)) {
    case 'transient': return 'retry';
    case 'correctable': return 'surface_to_caller';
    case 'terminal': return 'escalate_to_human';
    default: return 'escalate_to_human'; // unknown recovery = terminal
  }
}

describe('Transport error mapping test vectors', () => {
  it('should have a valid structure', () => {
    assert.equal(typeof data.version, 'number');
    assert.ok(Array.isArray(data.vectors));
    assert.ok(data.vectors.length > 0, 'must have at least one vector');

    for (const vector of data.vectors) {
      assert.ok(vector.id, 'each vector must have an id');
      assert.ok(vector.description, 'each vector must have a description');
      assert.ok(['mcp', 'a2a'].includes(vector.transport), `invalid transport: ${vector.transport}`);
      assert.ok(vector.response, 'each vector must have a response');
      assert.ok('expected_error' in vector, 'each vector must have expected_error (can be null)');
      assert.ok(vector.expected_action, 'each vector must have expected_action');
    }
  });

  for (const vector of data.vectors) {
    it(`should extract correctly: ${vector.description} [${vector.id}]`, () => {
      const extracted = extractAdcpError(vector.response);

      if (vector.expected_error === null) {
        assert.equal(extracted, null,
          `Expected null but got: ${JSON.stringify(extracted)}`);
      } else {
        assert.ok(extracted !== null,
          `Expected error but extraction returned null`);
        assert.deepStrictEqual(extracted, vector.expected_error,
          `Extracted error does not match expected for ${vector.id}`);
      }
    });

    it(`should determine correct action: ${vector.id}`, () => {
      const extracted = extractAdcpError(vector.response);
      const action = getExpectedAction(extracted);
      assert.equal(action, vector.expected_action,
        `Expected action ${vector.expected_action} but got ${action}`);
    });
  }

  it('should cover all transport paths', () => {
    const paths = new Set(data.vectors.map(v => `${v.transport}:${v.path}`));
    assert.ok(paths.has('mcp:structuredContent'), 'must have MCP structuredContent vector');
    assert.ok(paths.has('mcp:jsonrpc_error'), 'must have MCP JSON-RPC error vector');
    assert.ok(paths.has('mcp:text_fallback'), 'must have MCP text fallback vector');
    assert.ok(paths.has('a2a:artifact'), 'must have A2A artifact vector');
  });

  it('should cover all recovery classifications', () => {
    const recoveries = new Set(
      data.vectors
        .filter(v => v.expected_error && v.expected_error.recovery)
        .map(v => v.expected_error.recovery)
    );
    assert.ok(recoveries.has('transient'), 'must have transient recovery vector');
    assert.ok(recoveries.has('correctable'), 'must have correctable recovery vector');
    assert.ok(recoveries.has('terminal'), 'must have terminal recovery vector');
  });

  it('should have null-extraction vectors for legacy servers', () => {
    const nullVectors = data.vectors.filter(v => v.expected_error === null);
    assert.ok(nullVectors.length >= 2, 'must have at least 2 null-extraction vectors (MCP + A2A)');
    const transports = new Set(nullVectors.map(v => v.transport));
    assert.ok(transports.has('mcp'), 'must have MCP null-extraction vector');
    assert.ok(transports.has('a2a'), 'must have A2A null-extraction vector');
  });

  it('should have vectors testing missing recovery field', () => {
    const missingRecoveryVectors = data.vectors.filter(
      v => v.expected_error && !v.expected_error.recovery
    );
    assert.ok(missingRecoveryVectors.length >= 2,
      'must have at least 2 vectors with missing recovery field');
    const actions = new Set(missingRecoveryVectors.map(v => v.expected_action));
    assert.ok(actions.has('retry'), 'must have missing-recovery vector that infers transient');
    assert.ok(actions.has('escalate_to_human'), 'must have missing-recovery vector that defaults to terminal');
  });

  it('should have vectors testing null extraction from non-AdCP responses', () => {
    const nonAdcpVectors = data.vectors.filter(
      v => v.expected_error === null && v.expected_action === 'generic_error'
    );
    // Should have: legacy MCP text, legacy A2A, structuredContent without adcp_error,
    // JSON without adcp_error key, JSON-RPC error without adcp_error data,
    // -32029 without adcp_error data
    assert.ok(nonAdcpVectors.length >= 6,
      `must have at least 6 null-extraction vectors, got ${nonAdcpVectors.length}`);
  });
});
