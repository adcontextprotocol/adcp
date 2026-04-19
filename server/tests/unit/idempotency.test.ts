/**
 * Direct unit tests for the idempotency module. The end-to-end middleware
 * behavior is covered by training-agent-idempotency.test.ts; this file
 * exercises paths that are awkward to reach through the full dispatcher
 * (clock-skew arithmetic, per-principal cache cap, payload-exclusion list).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MUTATING_TOOLS,
  isMutatingTool,
  validateKeyFormat,
  payloadHash,
  lookupIdempotency,
  cacheResponse,
  clearIdempotencyCache,
  scopedPrincipal,
  isPrincipalAtCap,
  REPLAY_TTL_SECONDS,
} from '../../src/training-agent/idempotency.js';

describe('idempotency primitives', () => {
  beforeEach(() => clearIdempotencyCache());

  describe('MUTATING_TOOLS', () => {
    it('covers every mutating task whose schema requires idempotency_key', () => {
      // Smoke test: the set must contain the 26 mutating tools the training
      // agent actually dispatches. If a new mutating tool is added without
      // being listed here, callers can bypass the middleware.
      const expected = [
        'create_media_buy',
        'update_media_buy',
        'sync_creatives',
        'build_creative',
        'activate_signal',
        'sync_accounts',
        'sync_governance',
        'sync_catalogs',
        'sync_event_sources',
        'log_event',
        'provide_performance_feedback',
        'sync_plans',
        'report_plan_outcome',
        'acquire_rights',
        'update_rights',
        'creative_approval',
        'create_property_list',
        'update_property_list',
        'delete_property_list',
        'create_collection_list',
        'update_collection_list',
        'delete_collection_list',
        'create_content_standards',
        'update_content_standards',
        'calibrate_content',
        'report_usage',
      ];
      for (const name of expected) {
        expect(isMutatingTool(name), `${name} should be mutating`).toBe(true);
      }
      expect(MUTATING_TOOLS.size).toBe(expected.length);
    });

    it('excludes read-only and discovery tools', () => {
      for (const name of ['get_products', 'get_media_buys', 'get_adcp_capabilities', 'check_governance']) {
        expect(isMutatingTool(name)).toBe(false);
      }
    });
  });

  describe('validateKeyFormat', () => {
    it('accepts UUIDs and equivalent entropy shapes', () => {
      expect(validateKeyFormat('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(validateKeyFormat('A'.repeat(16))).toBe(true);
      expect(validateKeyFormat('A'.repeat(255))).toBe(true);
    });

    it('rejects keys outside the schema-mandated regex', () => {
      expect(validateKeyFormat('tooshort')).toBe(false);          // < 16
      expect(validateKeyFormat('A'.repeat(256))).toBe(false);    // > 255
      expect(validateKeyFormat('has spaces inside')).toBe(false);
      expect(validateKeyFormat('has/slashes/in/it-xxxx')).toBe(false);
      expect(validateKeyFormat(undefined)).toBe(false);
      expect(validateKeyFormat(42 as unknown)).toBe(false);
    });
  });

  describe('payloadHash', () => {
    it('ignores idempotency_key, context, governance_context', () => {
      const base = { account_id: 'acme', amount: 100 };
      expect(payloadHash({ ...base, idempotency_key: 'aaaaaaaaaaaaaaaa' }))
        .toBe(payloadHash({ ...base, idempotency_key: 'bbbbbbbbbbbbbbbb' }));
      expect(payloadHash({ ...base, context: { correlation_id: '1' } }))
        .toBe(payloadHash({ ...base, context: { correlation_id: '2' } }));
      expect(payloadHash({ ...base, governance_context: 'g1' }))
        .toBe(payloadHash({ ...base, governance_context: 'g2' }));
    });

    it('ignores rotating push_notification credentials', () => {
      const a = { x: 1, push_notification_config: { url: 'https://a', authentication: { credentials: 'secret-a' } } };
      const b = { x: 1, push_notification_config: { url: 'https://a', authentication: { credentials: 'secret-b' } } };
      expect(payloadHash(a)).toBe(payloadHash(b));
    });

    it('is key-order independent (JCS guarantee)', () => {
      expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
    });

    it('distinguishes materially different payloads', () => {
      expect(payloadHash({ budget: 5000 })).not.toBe(payloadHash({ budget: 25000 }));
    });

    it('distinguishes "missing optional field" from "explicit null"', () => {
      // security.mdx normative: missing ≠ explicit null
      expect(payloadHash({ x: 1 })).not.toBe(payloadHash({ x: 1, y: null }));
    });
  });

  describe('lookupIdempotency TTL behavior', () => {
    it('returns replay within TTL', () => {
      const payload = { foo: 'bar' };
      cacheResponse('p', 'key-aaaaaaaaaaaa01', payload, { media_buy_id: 'mb_1' });
      const outcome = lookupIdempotency('p', 'key-aaaaaaaaaaaa01', payload);
      expect(outcome.kind).toBe('replay');
      if (outcome.kind === 'replay') {
        expect(outcome.response.media_buy_id).toBe('mb_1');
      }
    });

    it('returns conflict when canonical payload drifts', () => {
      cacheResponse('p', 'key-aaaaaaaaaaaa02', { foo: 'bar' }, { media_buy_id: 'mb_1' });
      expect(lookupIdempotency('p', 'key-aaaaaaaaaaaa02', { foo: 'baz' }).kind).toBe('conflict');
    });

    it('returns expired past TTL + 60s skew, and evicts so the key can be reused', () => {
      const now = 1_000_000_000_000;
      const payload = { foo: 'bar' };
      cacheResponse('p', 'key-aaaaaaaaaaaa03', payload, { media_buy_id: 'mb_1' }, now);

      const beforeExpiry = now + REPLAY_TTL_SECONDS * 1000 + 30_000; // +30s < 60s skew
      expect(lookupIdempotency('p', 'key-aaaaaaaaaaaa03', payload, beforeExpiry).kind).toBe('replay');

      const afterExpiry = now + REPLAY_TTL_SECONDS * 1000 + 61_000; // +61s > 60s skew
      expect(lookupIdempotency('p', 'key-aaaaaaaaaaaa03', payload, afterExpiry).kind).toBe('expired');

      // Evicted — a fresh insert with the same key should now succeed
      cacheResponse('p', 'key-aaaaaaaaaaaa03', payload, { media_buy_id: 'mb_2' }, afterExpiry);
      const second = lookupIdempotency('p', 'key-aaaaaaaaaaaa03', payload, afterExpiry);
      expect(second.kind).toBe('replay');
      if (second.kind === 'replay') {
        expect(second.response.media_buy_id).toBe('mb_2');
      }
    });

    it('returns miss for unknown key', () => {
      expect(lookupIdempotency('p', 'never-seen-1234567', { foo: 1 }).kind).toBe('miss');
    });
  });

  describe('scopedPrincipal', () => {
    it('partitions shared auth tokens by account scope', () => {
      const a = scopedPrincipal('static:public', 'b:acme.example');
      const b = scopedPrincipal('static:public', 'b:beta.example');
      expect(a).not.toBe(b);

      cacheResponse(a, 'shared-key-uuuuu01', { x: 1 }, { id: 'acme' });
      // Same key on a different account scope is a miss — closes the
      // cross-caller oracle on the public sandbox token.
      expect(lookupIdempotency(b, 'shared-key-uuuuu01', { x: 1 }).kind).toBe('miss');
      expect(lookupIdempotency(a, 'shared-key-uuuuu01', { x: 1 }).kind).toBe('replay');
    });

    it('keeps auth principals that contain colons unambiguous', () => {
      // `workos:org_abc` vs `workos:org_abcdef` both contain `:`
      const p1 = scopedPrincipal('workos:org_abc', 'b:x.example');
      const p2 = scopedPrincipal('workos:org_abcdef', '');
      expect(p1).not.toBe(p2);
    });
  });

  describe('cache cap', () => {
    it('isPrincipalAtCap is false by default', () => {
      expect(isPrincipalAtCap('fresh')).toBe(false);
    });

    it('cacheResponse returns true on normal inserts', () => {
      expect(cacheResponse('p', 'unique-key-aaaaaa01', { a: 1 }, { id: 1 })).toBe(true);
    });
  });
});

describe('MUTATING_TOOLS drift guard', () => {
  // If a new mutating tool is added to task-handlers.ts but not listed in
  // MUTATING_TOOLS, buyers bypass the middleware. This test enumerates the
  // HANDLER_MAP shipped at runtime and asserts the set is complete.
  it('every HANDLER_MAP entry whose schema requires idempotency_key is in MUTATING_TOOLS', async () => {
    // HANDLER_MAP is module-private; we detect drift by introspecting the
    // server's tools/list response instead.
    const { createTrainingAgentServer } = await import('../../src/training-agent/task-handlers.js');
    const server = createTrainingAgentServer({ mode: 'open', principal: 'drift-check' });
    const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
    const listHandler = requestHandlers.get('tools/list');
    if (!listHandler) throw new Error('tools/list handler not registered');
    const { tools } = await listHandler({ method: 'tools/list' }, {}) as { tools: Array<{ name: string; inputSchema?: { required?: string[] } }> };

    // Any tool whose inputSchema lists `idempotency_key` as required is a
    // mutating tool and must be in MUTATING_TOOLS.
    const shouldBeMutating = tools
      .filter(t => Array.isArray(t.inputSchema?.required) && t.inputSchema!.required!.includes('idempotency_key'))
      .map(t => t.name);

    const missing = shouldBeMutating.filter(name => !MUTATING_TOOLS.has(name));
    expect(missing, `tools with required idempotency_key not in MUTATING_TOOLS: ${missing.join(', ')}`).toEqual([]);
  });
});
