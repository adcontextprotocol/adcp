/**
 * Validates MCP response extraction test vectors.
 *
 * Tests that the extraction logic for MCP success responses produces the
 * expected AdCP data from the tool result envelope. Client libraries
 * should also validate against these vectors.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const vectorsPath = path.join(__dirname, '..', 'static', 'test-vectors', 'mcp-response-extraction.json');
const data = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

/**
 * Reference extraction implementation matching the spec.
 *
 * Extracts AdCP success response data from an MCP tool result.
 * Returns null for error responses (isError: true) — those go through
 * the transport error extraction path instead.
 */
function extractAdcpResponseFromMcp(response) {
  // Error responses are handled by extractAdcpErrorFromMcp (transport-errors.mdx)
  if (response.isError) return null;

  // 1. structuredContent (preferred — MCP 2025-03-26+)
  if (response.structuredContent != null && typeof response.structuredContent === 'object'
      && !Array.isArray(response.structuredContent)) {
    const sc = response.structuredContent;

    // If structuredContent contains only adcp_error and nothing else,
    // this is an error response missing isError flag — return null
    const keys = Object.keys(sc);
    if (keys.length === 1 && keys[0] === 'adcp_error') return null;

    return sc;
  }

  // 2. Text fallback — JSON.parse content[].text
  if (response.content && Array.isArray(response.content)) {
    for (const item of response.content) {
      if (item.type === 'text' && item.text) {
        if (item.text.length > 1_048_576) continue; // 1MB size limit
        try {
          const parsed = JSON.parse(item.text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Skip adcp_error-only payloads (error response missing isError flag)
            const keys = Object.keys(parsed);
            if (keys.length === 1 && keys[0] === 'adcp_error') continue;
            return parsed;
          }
        } catch {
          // Not JSON, continue
        }
      }
    }
  }

  return null;
}

describe('MCP response extraction test vectors', () => {
  it('should have a valid structure', () => {
    assert.equal(typeof data.version, 'number');
    assert.ok(Array.isArray(data.vectors));
    assert.ok(data.vectors.length > 0, 'must have at least one vector');

    for (const vector of data.vectors) {
      assert.ok(vector.id, 'each vector must have an id');
      assert.ok(vector.description, 'each vector must have a description');
      assert.ok(vector.path, 'each vector must have a path');
      assert.ok(vector.response, 'each vector must have a response');
      assert.ok('expected_data' in vector, 'each vector must have expected_data (can be null)');
    }
  });

  for (const vector of data.vectors) {
    it(`should extract correctly: ${vector.description} [${vector.id}]`, () => {
      const extracted = extractAdcpResponseFromMcp(vector.response);

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

  it('should cover both extraction paths', () => {
    const paths = new Set(data.vectors.map(v => v.path));
    assert.ok(paths.has('structuredContent'), 'must have structuredContent vector');
    assert.ok(paths.has('text_fallback'), 'must have text fallback vector');
  });

  it('should have null-extraction vectors for error responses', () => {
    const errorVectors = data.vectors.filter(
      v => v.expected_data === null && v.response.isError
    );
    assert.ok(errorVectors.length >= 1, 'must have at least 1 isError null-extraction vector');
  });

  it('should have null-extraction vectors for non-JSON text', () => {
    const nonJsonVectors = data.vectors.filter(
      v => v.expected_data === null && !v.response.isError && !v.response.structuredContent
    );
    assert.ok(nonJsonVectors.length >= 1, 'must have at least 1 non-JSON null-extraction vector');
  });
});

describe('Validation and safety', () => {
  it('should not extract from isError: true responses', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: 'Error' }],
      isError: true,
      structuredContent: { products: [{ product_id: 'ctv_001' }] }
    });
    assert.equal(result, null, 'must not extract from error responses');
  });

  it('should not extract from isError: false responses via error path', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: 'Success' }],
      isError: false,
      structuredContent: { products: [{ product_id: 'ctv_001' }] }
    });
    assert.ok(result !== null, 'isError: false is a success response');
    assert.deepStrictEqual(result.products, [{ product_id: 'ctv_001' }]);
  });

  it('should not extract when text parses as array', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: '[{"product_id":"ctv_001"}]' }]
    });
    assert.equal(result, null, 'array parse result must not extract');
  });

  it('should not extract when text parses as string', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: '"just a string"' }]
    });
    assert.equal(result, null, 'string parse result must not extract');
  });

  it('should not extract when text parses as number', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: '42' }]
    });
    assert.equal(result, null, 'number parse result must not extract');
  });

  it('should return null for structuredContent with only adcp_error', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: 'Error.' }],
      structuredContent: {
        adcp_error: { code: 'RATE_LIMITED', recovery: 'transient' }
      }
    });
    assert.equal(result, null, 'adcp_error-only structuredContent must return null');
  });

  it('should extract structuredContent that has adcp_error alongside other data', () => {
    // Edge case: completed response with partial errors
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: 'Partial results.' }],
      structuredContent: {
        status: 'completed',
        products: [{ product_id: 'ctv_001' }],
        errors: [{ code: 'NO_DATA_IN_REGION' }]
      }
    });
    assert.ok(result !== null, 'should extract when other data present');
    assert.deepStrictEqual(result.products, [{ product_id: 'ctv_001' }]);
  });

  it('should handle null structuredContent', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: 'Hello' }],
      structuredContent: null
    });
    assert.equal(result, null);
  });

  it('should handle missing content array', () => {
    const result = extractAdcpResponseFromMcp({});
    assert.equal(result, null);
  });

  it('should handle empty content array', () => {
    const result = extractAdcpResponseFromMcp({
      content: []
    });
    assert.equal(result, null);
  });

  it('should not allow prototype pollution via __proto__ in structuredContent', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: 'OK' }],
      structuredContent: {
        status: 'completed',
        products: [],
        __proto__: { isAdmin: true }
      }
    });
    assert.ok(result !== null);
    assert.equal(({}).isAdmin, undefined, '__proto__ must not pollute Object prototype');
  });

  it('should prefer structuredContent over text JSON', () => {
    const result = extractAdcpResponseFromMcp({
      content: [{ type: 'text', text: '{"status":"completed","products":[{"product_id":"old"}]}' }],
      structuredContent: {
        status: 'completed',
        products: [{ product_id: 'new' }]
      }
    });
    assert.deepStrictEqual(result.products, [{ product_id: 'new' }],
      'structuredContent must take precedence');
  });
});
