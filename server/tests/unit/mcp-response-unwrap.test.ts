/**
 * Tests for MCP response unwrapping in the evaluator pipeline.
 *
 * Verifies that the response unwrapper correctly extracts AdCP data from
 * MCP content[0].text envelopes, and that the fallback in extractResponseData
 * doesn't silently return raw protocol envelopes as "data".
 *
 * Bug: When unwrapProtocolResponse(response, toolName) threw due to schema
 * validation inside the unwrapper, extractResponseData fell back to the raw
 * MCP CallToolResult. Downstream validators then checked the MCP envelope
 * against AdCP schemas, producing misleading errors like:
 *   - "formats: expected array, received undefined"
 *   - "(root): Invalid input"
 */
import { describe, it, expect } from 'vitest';
import { unwrapProtocolResponse, isAdcpError } from '@adcp/sdk';

/**
 * Wrap AdCP data in an MCP CallToolResult envelope (content[0].text).
 * This is the standard format returned by MCP SDK server handlers.
 */
function wrapInMCPEnvelope(data: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

/**
 * Behavioral spec for TaskExecutor.extractResponseData in @adcp/sdk.
 * Defined here (not imported) because extractResponseData is a private method.
 * Guards the retry-without-toolName contract: if schema validation fails,
 * the envelope should still be stripped before returning data.
 */
function extractResponseDataFixed(
  response: unknown,
  toolName?: string,
): unknown {
  try {
    return unwrapProtocolResponse(response, toolName);
  } catch {
    // Retry without toolName — skips schema validation in unwrapper
    // but still strips the MCP/A2A envelope
    try {
      return unwrapProtocolResponse(response);
    } catch {
      return response;
    }
  }
}

describe('MCP response unwrapping for evaluator', () => {
  describe('unwrapProtocolResponse', () => {
    it('extracts AdCP data from content[0].text', () => {
      const adcpData = { media_buy_id: 'MB-1', buyer_ref: 'ref', packages: [] };
      const mcpResponse = wrapInMCPEnvelope(adcpData);

      const unwrapped = unwrapProtocolResponse(mcpResponse);
      expect(unwrapped).toEqual(adcpData);
    });

    it('extracts AdCP data from structuredContent', () => {
      const adcpData = { media_buy_id: 'MB-1', buyer_ref: 'ref', packages: [] };
      const mcpResponse = {
        structuredContent: adcpData,
        content: [{ type: 'text' as const, text: 'Created successfully' }],
      };

      const unwrapped = unwrapProtocolResponse(mcpResponse);
      expect(unwrapped).toHaveProperty('media_buy_id', 'MB-1');
      expect(unwrapped).toHaveProperty('_message', 'Created successfully');
    });

    it('throws when called with toolName on data that fails schema validation', () => {
      // Data with minor schema issues (agent would return this, passes manual inspection)
      const partialData = {
        formats: [
          {
            format_id: { id: 'banner', provider: 'test' },
            // Missing agent_url — causes Zod schema validation to fail
            name: 'Banner',
            type: 'display',
            channels: ['display'],
            assets: [],
          },
        ],
      };
      const mcpResponse = wrapInMCPEnvelope(partialData);

      // With toolName: unwrapper runs schema validation and throws
      expect(() =>
        unwrapProtocolResponse(mcpResponse, 'list_creative_formats'),
      ).toThrow(/Response validation failed/);

      // Without toolName: unwrapper skips validation and extracts data
      const unwrapped = unwrapProtocolResponse(mcpResponse);
      expect(unwrapped).toHaveProperty('formats');
    });
  });

  describe('extractResponseData fallback', () => {
    it('should extract AdCP data even when schema validation in unwrapper fails', () => {
      const adcpData = {
        formats: [
          {
            format_id: { id: 'banner', provider: 'test' },
            name: 'Banner',
            type: 'display',
            channels: ['display'],
            assets: [],
          },
        ],
      };
      const mcpResponse = wrapInMCPEnvelope(adcpData);

      const result = extractResponseDataFixed(mcpResponse, 'list_creative_formats');

      // Should have unwrapped data, NOT the raw MCP envelope
      expect(result).toHaveProperty('formats');
      expect(result).not.toHaveProperty('content');
    });

    it('should return unwrapped data for create_media_buy', () => {
      const adcpData = {
        media_buy_id: 'MB-12345',
        buyer_ref: 'test-buyer-ref',
        packages: [
          {
            package_id: 'PKG-001',
            buyer_ref: 'pkg-ref-001',
            product_id: 'PROD-001',
            budget: 5000,
            pricing_option_id: 'PO-001',
            status: 'pending_start',
          },
        ],
      };
      const mcpResponse = wrapInMCPEnvelope(adcpData);

      const result = extractResponseDataFixed(mcpResponse, 'create_media_buy');

      expect(result).toHaveProperty('media_buy_id', 'MB-12345');
      expect(result).toHaveProperty('packages');
      expect(result).not.toHaveProperty('content');
    });

    it('should never return raw MCP envelope as data for valid JSON responses', () => {
      // Any valid JSON in content[0].text should be extracted, regardless of
      // whether it passes AdCP schema validation
      const anyData = { foo: 'bar', nested: { value: 42 } };
      const mcpResponse = wrapInMCPEnvelope(anyData);

      const result = extractResponseDataFixed(mcpResponse, 'unknown_tool');

      expect(result).toEqual(anyData);
      expect(result).not.toHaveProperty('content');
    });
  });

  describe('error response handling', () => {
    it('extracts AdCP error from isError + content[0].text', () => {
      const adcpError = {
        adcp_error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required field',
        },
      };
      const mcpResponse = {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(adcpError) }],
      };

      const unwrapped = unwrapProtocolResponse(mcpResponse);
      expect(isAdcpError(unwrapped)).toBe(true);
    });

    it('extracts structuredContent-only MCP errors when present', () => {
      const mcpResponse = {
        isError: true,
        structuredContent: {
          adcp_error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests',
            retry_after: 30,
          },
        },
      };

      const unwrapped = unwrapProtocolResponse(mcpResponse) as { adcp_error?: { code: string; message: string } };
      expect(isAdcpError(unwrapped)).toBe(true);
      expect(unwrapped.adcp_error?.code).toBe('RATE_LIMITED');
      expect(unwrapped.adcp_error?.message).toBe('Too many requests');
    });
  });
});
