/**
 * Unit tests for the training agent's idempotency facade.
 *
 * The behaviour tests (miss / replay / conflict / expired, TTL skew, JCS
 * exclusion list) live in `@adcp/client`'s own test suite — the facade just
 * delegates. What this file covers:
 *
 * - `MUTATING_TOOLS` drift against the request schemas (security-critical —
 *   a missing entry means a mutating tool silently bypasses idempotency).
 * - `validateKeyFormat` — the regex gate we apply before the store is
 *   touched, so a malformed key never influences cache timing.
 * - `scopedPrincipal` — the account-partitioning composition for the shared
 *   public sandbox token, verified end-to-end against the live store.
 * - `payloadHash` exclusion list — verifies the SDK's `hashPayload` honours
 *   the spec-required exclusions so callers can rely on them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MUTATING_TOOLS,
  isMutatingTool,
  validateKeyFormat,
  payloadHash,
  scopedPrincipal,
  getIdempotencyStore,
  clearIdempotencyCache,
} from '../../src/training-agent/idempotency.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('idempotency facade', () => {
  beforeEach(async () => {
    await clearIdempotencyCache();
  });

  describe('MUTATING_TOOLS', () => {
    it('matches the set derived from request schemas', () => {
      // Source of truth: static/schemas/source/**\/*-request.json. Every
      // schema whose top-level `required` contains `idempotency_key` names a
      // mutating tool. This re-derives the set at test time so MUTATING_TOOLS
      // drift against the schemas fails CI (see red-team finding I-1, which
      // caught si_initiate_session, si_send_message, and sync_audiences
      // silently bypassing replay enforcement).
      const schemasDir = path.resolve(__dirname, '../../../static/schemas/source');
      const derived = new Set<string>();
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) { walk(p); continue; }
          if (!entry.name.endsWith('-request.json')) continue;
          let schema: { required?: unknown };
          try { schema = JSON.parse(fs.readFileSync(p, 'utf8')) as { required?: unknown }; }
          catch { continue; }
          const req = Array.isArray(schema.required) ? schema.required : [];
          if (req.includes('idempotency_key')) {
            derived.add(entry.name.replace(/-request\.json$/, '').replace(/-/g, '_'));
          }
        }
      };
      walk(schemasDir);

      const actual = new Set(MUTATING_TOOLS);
      const missing = [...derived].filter((t) => !actual.has(t)).sort();
      const extra = [...actual].filter((t) => !derived.has(t)).sort();
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it('covers specific mutating tools explicitly', () => {
      for (const name of [
        'create_media_buy', 'update_media_buy', 'sync_audiences',
        'si_initiate_session', 'si_send_message',
        'acquire_rights', 'update_rights', 'creative_approval',
      ]) {
        expect(isMutatingTool(name), `${name} should be mutating`).toBe(true);
      }
    });

    it('excludes read-only and discovery tools', () => {
      for (const name of [
        'get_products',
        'get_media_buys',
        'get_adcp_capabilities',
        'check_governance',
        'si_terminate_session',
      ]) {
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

  describe('payloadHash (SDK hashPayload)', () => {
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

  describe('scopedPrincipal partitioning', () => {
    it('partitions shared auth tokens by account scope, end-to-end via the store', async () => {
      const a = scopedPrincipal('static:public', 'b:acme.example');
      const b = scopedPrincipal('static:public', 'b:beta.example');
      expect(a).not.toBe(b);

      const store = getIdempotencyStore();
      const payload = { x: 1 };

      // Insert under account A
      const firstCheck = await store.check({ principal: a, key: 'shared-key-uuuuu01', payload });
      expect(firstCheck.kind).toBe('miss');
      if (firstCheck.kind === 'miss') {
        await store.save({
          principal: a,
          key: 'shared-key-uuuuu01',
          payloadHash: firstCheck.payloadHash,
          response: { id: 'acme' },
        });
      }

      // Same key under account B is a miss (the public-token oracle is closed).
      const otherAccount = await store.check({ principal: b, key: 'shared-key-uuuuu01', payload });
      expect(otherAccount.kind).toBe('miss');
      if (otherAccount.kind === 'miss') {
        await store.release({ principal: b, key: 'shared-key-uuuuu01' });
      }

      // Same key under account A replays.
      const sameAccount = await store.check({ principal: a, key: 'shared-key-uuuuu01', payload });
      expect(sameAccount.kind).toBe('replay');
    });

    it('keeps auth principals that contain colons unambiguous', () => {
      // `workos:org_abc` vs `workos:org_abcdef` both contain `:`
      const p1 = scopedPrincipal('workos:org_abc', 'b:x.example');
      const p2 = scopedPrincipal('workos:org_abcdef', '');
      expect(p1).not.toBe(p2);
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
