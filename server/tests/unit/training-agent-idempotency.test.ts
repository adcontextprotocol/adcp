/**
 * Training agent idempotency middleware — validates the behavior documented
 * in `docs/building/implementation/security.mdx` and the universal
 * `idempotency.yaml` compliance storyboard.
 *
 * Addresses #2346: the training agent previously declared
 * `adcp.idempotency.replay_ttl_seconds` in get_adcp_capabilities but did
 * NOT enforce the replay / conflict / expired semantics that declaration
 * implies — buyers building against the reference agent never observed
 * IDEMPOTENCY_CONFLICT or IDEMPOTENCY_EXPIRED and could silently double-book
 * on retry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open', principal: 'test-principal' };

const ACCOUNT = { brand: { domain: 'idem-test.example' }, operator: 'idem-op' };
const BRAND = { domain: 'idem-test.example' };

async function call(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    {},
  );
  const text = response.content?.[0]?.text;
  return { parsed: text ? JSON.parse(text) : {}, isError: response.isError };
}

const basePayload = () => ({
  account: ACCOUNT,
  brand: BRAND,
  start_time: '2026-06-01T00:00:00Z',
  end_time: '2026-06-30T23:59:59Z',
  packages: [{ product_id: 'test-product', budget: 5000, pricing_option_id: 'test-pricing' }],
});

async function getValidProductAndPricing(
  server: ReturnType<typeof createTrainingAgentServer>,
): Promise<{ productId: string; pricingOptionId: string }> {
  const { parsed } = await call(server, 'get_products', {
    buying_mode: 'wholesale',
    account: ACCOUNT,
    brand: BRAND,
  });
  const products = (parsed as { products?: Array<{ product_id: string; pricing_options: Array<{ pricing_option_id: string }> }> }).products ?? [];
  if (!products.length) throw new Error('no products in catalog');
  return {
    productId: products[0].product_id,
    pricingOptionId: products[0].pricing_options[0].pricing_option_id,
  };
}

describe('training agent idempotency middleware', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    clearIdempotencyCache();
    server = createTrainingAgentServer(CTX);
  });

  describe('missing / malformed key', () => {
    it('rejects create_media_buy with no idempotency_key → INVALID_REQUEST', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const { parsed, isError } = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
      });
      expect(isError).toBe(true);
      expect((parsed as any).adcp_error?.code).toBe('INVALID_REQUEST');
      expect((parsed as any).adcp_error?.field).toBe('idempotency_key');
    });

    it('rejects create_media_buy with too-short key → INVALID_REQUEST', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const { parsed, isError } = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: 'short',
      });
      expect(isError).toBe(true);
      expect((parsed as any).adcp_error?.code).toBe('INVALID_REQUEST');
    });

    it('does not require idempotency_key on read-only tools', async () => {
      const { isError } = await call(server, 'get_products', {
        buying_mode: 'wholesale',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(isError).toBeFalsy();
    });
  });

  describe('replay with same key + same payload', () => {
    it('returns the cached media_buy_id with replayed: true', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      };

      const first = await call(server, 'create_media_buy', payload);
      expect(first.isError).toBeFalsy();
      const originalMediaBuyId = (first.parsed as any).media_buy_id;
      expect(originalMediaBuyId).toBeTruthy();
      // Fresh execution: `replayed` should be false or omitted
      expect((first.parsed as any).replayed ?? false).toBe(false);

      // Replay with the same key and the same payload
      const second = await call(server, 'create_media_buy', { ...payload });
      expect(second.isError).toBeFalsy();
      expect((second.parsed as any).media_buy_id).toBe(originalMediaBuyId);
      expect((second.parsed as any).replayed).toBe(true);
    });

    it('echoes a fresh context block on replay (envelope-level, not cached)', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
        context: { correlation_id: 'first-call' },
      };

      await call(server, 'create_media_buy', payload);

      const replay = await call(server, 'create_media_buy', {
        ...payload,
        context: { correlation_id: 'retry-call' },
      });
      // Context is excluded from the canonical hash (see EXCLUDED_FROM_HASH),
      // so retry with a different correlation_id is still a replay. Envelope
      // context echoes the NEW correlation_id, not the cached one.
      expect((replay.parsed as any).replayed).toBe(true);
      expect((replay.parsed as any).context?.correlation_id).toBe('retry-call');
    });

    it('treats governance_context as excluded from the hash (retry with new delegation)', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
        governance_context: 'gov-token-a',
      };

      await call(server, 'create_media_buy', payload);
      const replay = await call(server, 'create_media_buy', { ...payload, governance_context: 'gov-token-b' });
      expect((replay.parsed as any).replayed).toBe(true);
    });
  });

  describe('key reuse with different payload', () => {
    it('returns IDEMPOTENCY_CONFLICT when budget changes', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });

      const conflict = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 25000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });
      expect(conflict.isError).toBe(true);
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
      // Security: no payload / fingerprint / cached state leak
      expect((conflict.parsed as any).adcp_error?.details?.hash).toBeUndefined();
      expect((conflict.parsed as any).adcp_error?.details?.cached_payload).toBeUndefined();
    });

    it('returns IDEMPOTENCY_CONFLICT when end_time changes', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });

      const conflict = await call(server, 'create_media_buy', {
        ...basePayload(),
        end_time: '2026-09-30T23:59:59Z',
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('fresh key → new resource', () => {
    it('a different key with identical payload creates a distinct media buy', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const basePkg = { product_id: productId, budget: 5000, pricing_option_id: pricingOptionId };

      const first = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [basePkg],
        idempotency_key: `idem-${randomUUID()}`,
      });
      const firstId = (first.parsed as any).media_buy_id;

      const second = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [basePkg],
        idempotency_key: `idem-${randomUUID()}`,
      });
      const secondId = (second.parsed as any).media_buy_id;

      expect(firstId).toBeTruthy();
      expect(secondId).toBeTruthy();
      expect(firstId).not.toBe(secondId);
    });
  });

  describe('failed executions are not cached', () => {
    it('re-executes on retry after an error (no replay cache pollution)', async () => {
      const key = `idem-${randomUUID()}`;
      const badPayload = {
        ...basePayload(),
        packages: [{ product_id: 'DOES_NOT_EXIST', budget: 100, pricing_option_id: 'bad' }],
        idempotency_key: key,
      };

      const first = await call(server, 'create_media_buy', badPayload);
      expect(first.isError).toBe(true);

      // Retry with the same key: the first was an error, so the second
      // must re-execute (and also error) — not return a cached success.
      const second = await call(server, 'create_media_buy', badPayload);
      expect(second.isError).toBe(true);
      expect((second.parsed as any).replayed).toBeUndefined();
    });
  });

  describe('principal isolation', () => {
    it('the same key used by a different auth principal is a cache miss', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      };
      const first = await call(server, 'create_media_buy', payload);
      const firstId = (first.parsed as any).media_buy_id;

      const otherServer = createTrainingAgentServer({ mode: 'open', principal: 'other-principal' });
      const second = await call(otherServer, 'create_media_buy', payload);
      const secondId = (second.parsed as any).media_buy_id;

      expect(firstId).toBeTruthy();
      expect(secondId).toBeTruthy();
      expect(secondId).not.toBe(firstId);
      expect((second.parsed as any).replayed ?? false).toBe(false);
    });

    it('partitions by account scope so shared auth tokens do not pool callers', async () => {
      // Both calls are made against the SAME server (same auth principal),
      // but the account brand.domain differs. The middleware must treat
      // these as separate cache scopes — otherwise the public sandbox
      // token would be a cross-caller oracle.
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `shared-${randomUUID()}`;
      const pkg = { product_id: productId, budget: 5000, pricing_option_id: pricingOptionId };

      const payloadA = {
        account: { brand: { domain: 'caller-a.example' }, operator: 'op' },
        brand: { domain: 'caller-a.example' },
        start_time: '2026-06-01T00:00:00Z',
        end_time: '2026-06-30T23:59:59Z',
        packages: [pkg],
        idempotency_key: key,
      };
      const payloadB = {
        ...payloadA,
        account: { brand: { domain: 'caller-b.example' }, operator: 'op' },
        brand: { domain: 'caller-b.example' },
      };

      const a = await call(server, 'create_media_buy', payloadA);
      const b = await call(server, 'create_media_buy', payloadB);

      expect((a.parsed as any).media_buy_id).toBeTruthy();
      expect((b.parsed as any).media_buy_id).toBeTruthy();
      // Different account scope → cache miss, new media buy, no conflict
      expect((b.parsed as any).media_buy_id).not.toBe((a.parsed as any).media_buy_id);
      expect((b.parsed as any).replayed ?? false).toBe(false);
      expect(b.isError).toBeFalsy();
    });
  });

  describe('missing key rejected for every mutating tool', () => {
    // Parameterized sanity check: the middleware must reject all mutating
    // tools at the dispatch layer regardless of whether the handler would
    // have validated the field itself. Catches routing regressions where a
    // new tool is added to HANDLER_MAP but omitted from MUTATING_TOOLS.
    for (const toolName of MUTATING_TOOLS) {
      it(`${toolName}: missing idempotency_key → INVALID_REQUEST`, async () => {
        const { parsed, isError } = await call(server, toolName, {
          account: ACCOUNT,
          brand: BRAND,
        });
        expect(isError).toBe(true);
        expect((parsed as any).adcp_error?.code).toBe('INVALID_REQUEST');
        expect((parsed as any).adcp_error?.field).toBe('idempotency_key');
      });
    }
  });
});
