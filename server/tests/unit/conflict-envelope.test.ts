/**
 * Direct tests for the `IDEMPOTENCY_CONFLICT` envelope redactor. Guards the
 * allowlist that the universal idempotency storyboard's
 * `conflict_no_payload_leak` invariant enforces — adding a new envelope
 * field here without updating the allowlist would regress the invariant.
 */

import { describe, it, expect } from 'vitest';
import {
  redactConflictEnvelopes,
  redactConflictEnvelopeInBody,
} from '../../src/training-agent/conflict-envelope.js';

function buildConflictResponse(extraEnvelopeFields: Record<string, unknown>): Record<string, unknown> {
  const envelope = {
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Key reuse rejected',
    ...extraEnvelopeFields,
  };
  return {
    jsonrpc: '2.0',
    id: 42,
    result: {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ adcp_error: envelope }) }],
      structuredContent: { adcp_error: { ...envelope } },
    },
  };
}

describe('redactConflictEnvelopes', () => {
  it('strips disallowed envelope keys from structuredContent and the text fallback', () => {
    const response = buildConflictResponse({
      recovery: 'correctable',
      field: '/packages/0/budget',
      details: { prior_budget: 5000 },
    });
    redactConflictEnvelopes(response);

    const structured = (response.result as { structuredContent: { adcp_error: Record<string, unknown> } })
      .structuredContent.adcp_error;
    expect(Object.keys(structured).sort()).toEqual(['code', 'message']);

    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text) as { adcp_error: Record<string, unknown> };
    expect(Object.keys(parsed.adcp_error).sort()).toEqual(['code', 'message']);
  });

  it('preserves allowlisted envelope keys', () => {
    const response = buildConflictResponse({
      status: 'failed',
      retry_after: 1,
      correlation_id: 'req-1',
      request_id: 'req-1',
      operation_id: 'op-1',
      recovery: 'correctable',
    });
    redactConflictEnvelopes(response);

    const structured = (response.result as { structuredContent: { adcp_error: Record<string, unknown> } })
      .structuredContent.adcp_error;
    expect(structured.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(structured.message).toBe('Key reuse rejected');
    expect(structured.status).toBe('failed');
    expect(structured.retry_after).toBe(1);
    expect(structured.correlation_id).toBe('req-1');
    expect(structured.request_id).toBe('req-1');
    expect(structured.operation_id).toBe('op-1');
    expect('recovery' in structured).toBe(false);
  });

  it('leaves non-conflict envelopes untouched', () => {
    const response = {
      result: {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ adcp_error: { code: 'VALIDATION_ERROR', message: 'bad', recovery: 'correctable', field: '/x' } }) }],
        structuredContent: { adcp_error: { code: 'VALIDATION_ERROR', message: 'bad', recovery: 'correctable', field: '/x' } },
      },
    };
    redactConflictEnvelopes(response);
    const env = (response.result.structuredContent as { adcp_error: Record<string, unknown> }).adcp_error;
    expect(env).toEqual({ code: 'VALIDATION_ERROR', message: 'bad', recovery: 'correctable', field: '/x' });
  });

  it('handles success responses as a pass-through', () => {
    const response = {
      result: {
        content: [{ type: 'text', text: JSON.stringify({ media_buy_id: 'mb_1' }) }],
        structuredContent: { media_buy_id: 'mb_1' },
      },
    };
    const clone = structuredClone(response);
    redactConflictEnvelopes(response);
    expect(response).toEqual(clone);
  });

  it('descends into nested arrays and strips every conflict envelope', () => {
    const response = {
      result: {
        structuredContent: {
          adcp_error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'outer',
            recovery: 'correctable',
          },
          nested: [
            {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    adcp_error: {
                      code: 'IDEMPOTENCY_CONFLICT',
                      message: 'inner',
                      details: { prior_budget: 5000 },
                    },
                  }),
                },
              ],
            },
          ],
        },
      },
    };
    redactConflictEnvelopes(response);

    const outer = response.result.structuredContent.adcp_error as Record<string, unknown>;
    expect(Object.keys(outer).sort()).toEqual(['code', 'message']);

    const innerText = response.result.structuredContent.nested[0].content[0].text;
    const innerEnv = (JSON.parse(innerText) as { adcp_error: Record<string, unknown> }).adcp_error;
    expect(Object.keys(innerEnv).sort()).toEqual(['code', 'message']);
  });

  it('ignores malformed text entries without throwing', () => {
    const response = {
      result: {
        content: [{ type: 'text', text: '{not-json' }],
        structuredContent: { adcp_error: { code: 'IDEMPOTENCY_CONFLICT', message: 'x', recovery: 'correctable' } },
      },
    };
    expect(() => redactConflictEnvelopes(response)).not.toThrow();
    const env = (response.result.structuredContent as { adcp_error: Record<string, unknown> }).adcp_error;
    expect('recovery' in env).toBe(false);
  });
});

describe('redactConflictEnvelopeInBody', () => {
  it('returns the body unchanged when no conflict code appears', () => {
    const body = JSON.stringify({ result: { structuredContent: { ok: true } } });
    expect(redactConflictEnvelopeInBody(body)).toBe(body);
  });

  it('returns the body unchanged when parsing fails', () => {
    const body = '{not-json IDEMPOTENCY_CONFLICT';
    expect(redactConflictEnvelopeInBody(body)).toBe(body);
  });

  it('rewrites JSON bodies that carry a conflict envelope', () => {
    const original = buildConflictResponse({ recovery: 'correctable', field: '/x' });
    const body = JSON.stringify(original);
    const rewritten = redactConflictEnvelopeInBody(body);
    expect(rewritten).not.toBe(body);
    const parsed = JSON.parse(rewritten);
    const env = parsed.result.structuredContent.adcp_error;
    expect(Object.keys(env).sort()).toEqual(['code', 'message']);
    // Text fallback mirrors structuredContent
    const inner = JSON.parse(parsed.result.content[0].text);
    expect(Object.keys(inner.adcp_error).sort()).toEqual(['code', 'message']);
  });
});
