import { describe, it, expect } from 'vitest';
import { deriveWebhookIdempotencyScope } from '../../src/training-agent/webhooks.js';

describe('deriveWebhookIdempotencyScope', () => {
  it('prefixes the scope key with the caller principal so two buyers on the shared sandbox token producing the same response entity id get distinct webhook idempotency_keys', () => {
    const response = { media_buy_id: 'mb_abc123' };
    const a = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, 'static:publicb:buyer-a.example');
    const b = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, 'static:publicb:buyer-b.example');
    expect(a).not.toBe(b);
    expect(a).toContain('mb_abc123');
    expect(b).toContain('mb_abc123');
  });

  it('returns the same scope key for the same principal + entity id (so retries collapse)', () => {
    const response = { media_buy_id: 'mb_abc123' };
    const principal = 'workos:org_x';
    const first = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, principal);
    const second = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, principal);
    expect(first).toBe(second);
  });

  it('falls back to the request idempotency_key when no entity id is present, still scoped by principal', () => {
    const a = deriveWebhookIdempotencyScope('sync_creatives', {}, 'idemp-key-1', 'static:publicb:buyer-a.example');
    const b = deriveWebhookIdempotencyScope('sync_creatives', {}, 'idemp-key-1', 'static:publicb:buyer-b.example');
    expect(a).not.toBe(b);
    expect(a).toContain('idemp-key-1');
    expect(b).toContain('idemp-key-1');
  });

  it('walks the entity-id field list in order (media_buy_id wins over creative_id)', () => {
    const response = { media_buy_id: 'mb_1', creative_id: 'cr_1' };
    const id = deriveWebhookIdempotencyScope('create_media_buy', response, undefined, 'p');
    expect(id).toBe('p|create_media_buy.mb_1');
  });

  it('still applies the principal prefix on the random-UUID fallback (no entity id, no request idempotency key)', () => {
    const a = deriveWebhookIdempotencyScope('create_media_buy', {}, undefined, 'p');
    const b = deriveWebhookIdempotencyScope('create_media_buy', {}, undefined, 'p');
    expect(a).not.toBe(b); // different UUIDs
    expect(a).toMatch(/^p\|create_media_buy\./);
    expect(b).toMatch(/^p\|create_media_buy\./);
  });

  it('does not collide when a principal contains the same `|` character used as the prefix separator', () => {
    const a = deriveWebhookIdempotencyScope('create_media_buy', { media_buy_id: 'mb_1' }, undefined, 'a|b');
    const b = deriveWebhookIdempotencyScope('create_media_buy', { media_buy_id: 'mb_1' }, undefined, 'a');
    expect(a).not.toBe(b);
  });
});
