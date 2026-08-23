import { describe, it, expect } from 'vitest';
import { deriveWebhookIdempotencyScope } from '../../src/training-agent/webhooks.js';

describe('deriveWebhookIdempotencyScope', () => {
  it('includes the caller principal in the opaque identity so shared-sandbox buyers remain distinct', () => {
    const response = { media_buy_id: 'mb_abc123' };
    const a = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, 'static:publicb:buyer-a.example');
    const b = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, 'static:publicb:buyer-b.example');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^whd_[0-9a-f]{64}$/);
    expect(b).toMatch(/^whd_[0-9a-f]{64}$/);
  });

  it('returns the same scope key for the same principal + entity id (so retries collapse)', () => {
    const response = { media_buy_id: 'mb_abc123' };
    const principal = 'workos:org_x';
    const first = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, principal);
    const second = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, principal);
    expect(first).toBe(second);
  });

  it('uses the request idempotency_key when no entity id is present, still scoped by principal', () => {
    const a = deriveWebhookIdempotencyScope('sync_creatives', {}, 'idemp-key-1', 'static:publicb:buyer-a.example');
    const b = deriveWebhookIdempotencyScope('sync_creatives', {}, 'idemp-key-1', 'static:publicb:buyer-b.example');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^whd_[0-9a-f]{64}$/);
    expect(b).toMatch(/^whd_[0-9a-f]{64}$/);
  });

  it('prefers the exact request idempotency key so distinct updates to one entity do not collide', () => {
    const response = { media_buy_id: 'mb_1' };
    const first = deriveWebhookIdempotencyScope('update_media_buy', response, 'update-key-0000001', 'workos:org_x');
    const second = deriveWebhookIdempotencyScope('update_media_buy', response, 'update-key-0000002', 'workos:org_x');
    const retry = deriveWebhookIdempotencyScope('update_media_buy', response, 'update-key-0000001', 'workos:org_x');

    expect(first).not.toBe(second);
    expect(retry).toBe(first);
    expect(first).toMatch(/^whd_[0-9a-f]{64}$/);
  });

  it('walks the entity-id field list in order (media_buy_id wins over creative_id)', () => {
    const response = { media_buy_id: 'mb_1', creative_id: 'cr_1' };
    const id = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, 'p');
    expect(id).toBe(deriveWebhookIdempotencyScope(
      'create_media_buy',
      { media_buy_id: 'mb_1' },
      undefined,
      'p',
    ));
  });

  it('keeps the random-UUID fallback opaque when no stable request or entity id exists', () => {
    const a = deriveWebhookIdempotencyScope('create_media_buy', {}, undefined, 'p');
    const b = deriveWebhookIdempotencyScope('create_media_buy', {}, undefined, 'p');
    expect(a).not.toBe(b); // different UUIDs
    expect(a).toMatch(/^whd_[0-9a-f]{64}$/);
    expect(b).toMatch(/^whd_[0-9a-f]{64}$/);
  });

  it('does not collide when one principal contains another principal plus a separator', () => {
    const a = deriveWebhookIdempotencyScope('create_media_buy', { media_buy_id: 'mb_1' }, undefined, 'a|b');
    const b = deriveWebhookIdempotencyScope('create_media_buy', { media_buy_id: 'mb_1' }, undefined, 'a');
    expect(a).not.toBe(b);
  });
});
