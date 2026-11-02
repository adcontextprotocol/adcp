/**
 * Collection card webhooks (experimental, `media_buy.collection_catalog`):
 * `collection_card.updated`, `collection_card.removed` and
 * `collection_catalog.bulk_change`, pushed to account-level subscribers
 * registered through `sync_accounts` `notification_configs`.
 *
 * Envelope (list_collections.mdx, "Envelope"): the wholesale feed webhook,
 * with `notification_id` equal to `event.event_id`, `wholesale_feed_version`
 * the post-change `collections_version` of the unfiltered catalog and
 * `previous_wholesale_feed_version` the one before it, no
 * `product_payload_view`, and `cache_scope` equal to `applies_to.scope`.
 * Event ids are UUID v7 and strictly increasing, so a mirror can detect an
 * out-of-order delivery. Deliveries are RFC 9421-signed by the shared
 * emitter (webhooks.ts).
 *
 * Visibility: every card is public within the principal's sandbox, so every
 * subscriber on the principal's accounts may see every card event.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { WebhookAuthentication } from '@adcp/sdk/server';
import { getPrincipalNotificationSubscribers } from '../account-handlers.js';
import { emitAccountNotificationWebhook } from '../webhooks.js';
import { keyOf, type CollectionCard, type CollectionCardEventType, type CollectionKey } from './card-catalog.js';

export type CardEvent =
  | {
    type: 'collection_card.updated';
    card: CollectionCard;
    changedFields?: string[];
    previousVersion: string;
    version: string;
  }
  | {
    type: 'collection_card.removed';
    key: CollectionKey;
    removalReason?: string;
    previousVersion: string;
    version: string;
  }
  | {
    type: 'collection_catalog.bulk_change';
    summary: string;
    affectedCount: number;
    previousVersion: string;
    version: string;
  };

let lastMs = 0;
let sequence = 0;

/** A UUID v7 that sorts after every earlier one from this process, also
 * within one millisecond (RFC 9562 method 1: a counter in rand_a). */
export function monotonicUuidV7(now = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    sequence = 0;
  } else {
    sequence += 1;
    if (sequence > 0xfff) {
      lastMs += 1;
      sequence = 0;
    }
  }
  const bytes = randomBytes(16);
  const ms = lastMs;
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Opaque entity id; receivers key the mirror on the payload's key. */
function cardEntityId(key: CollectionKey): string {
  return `card_${createHash('sha256').update(keyOf(key)).digest('hex').slice(0, 16)}`;
}

/** The event (without subscriber fields) for one card change. */
export function cardEventEnvelope(event: CardEvent, firedAt: string): {
  notification_id: string;
  notification_type: CollectionCardEventType;
  fired_at: string;
  wholesale_feed_version: string;
  previous_wholesale_feed_version: string;
  cache_scope: 'public';
  event: Record<string, unknown>;
} {
  const eventId = monotonicUuidV7();
  const appliesTo = { scope: 'public' as const };
  const body = event.type === 'collection_card.updated'
    ? {
      entity_type: 'collection',
      entity_id: cardEntityId(event.card),
      payload: {
        collection: event.card,
        ...(event.changedFields && event.changedFields.length > 0 && { changed_fields: event.changedFields }),
        applies_to: appliesTo,
      },
    }
    : event.type === 'collection_card.removed'
      ? {
        entity_type: 'collection',
        entity_id: cardEntityId(event.key),
        payload: {
          publisher_domain: event.key.publisher_domain,
          collection_id: event.key.collection_id,
          ...(event.removalReason && { removal_reason: event.removalReason }),
          applies_to: appliesTo,
        },
      }
      : {
        entity_type: 'feed',
        entity_id: 'collection_catalog',
        payload: {
          summary: event.summary,
          affected_count: event.affectedCount,
          recommendation: 'wholesale_resync',
          applies_to: appliesTo,
        },
      };
  return {
    notification_id: eventId,
    notification_type: event.type,
    fired_at: firedAt,
    wholesale_feed_version: event.version,
    previous_wholesale_feed_version: event.previousVersion,
    cache_scope: 'public',
    event: { event_id: eventId, event_type: event.type, ...body, created_at: firedAt },
  };
}

function webhookAuthentication(
  auth: { schemes: string[]; credentials?: string } | undefined,
): WebhookAuthentication | undefined {
  if (!auth?.credentials) return undefined;
  const schemes = auth.schemes.map(scheme => scheme.toLowerCase().replace(/-/g, '_'));
  if (schemes.includes('bearer')) return { type: 'bearer', token: auth.credentials };
  if (schemes.includes('hmac_sha256')) return { type: 'hmac_sha256', secret: auth.credentials };
  return undefined;
}

export interface CardDeliveryReport {
  events: Array<{ notification_type: string; notification_id: string; wholesale_feed_version: string }>;
  subscribers: number;
  delivered: number;
  failures: string[];
}

/** Push the events, in order, to every subscriber of each event's type on
 * the principal's accounts. */
export async function deliverCardEvents(principal: string | undefined, events: readonly CardEvent[]): Promise<CardDeliveryReport> {
  const report: CardDeliveryReport = { events: [], subscribers: 0, delivered: 0, failures: [] };
  const counted = new Set<string>();
  for (const event of events) {
    const envelope = cardEventEnvelope(event, new Date().toISOString());
    report.events.push({
      notification_type: envelope.notification_type,
      notification_id: envelope.notification_id,
      wholesale_feed_version: envelope.wholesale_feed_version,
    });
    for (const subscriber of getPrincipalNotificationSubscribers(principal, event.type)) {
      const subscriberKey = `${subscriber.accountId}\u001F${subscriber.subscriberId}`;
      if (!counted.has(subscriberKey)) {
        counted.add(subscriberKey);
        report.subscribers += 1;
      }
      const idempotencyKey = `whk_${monotonicUuidV7()}`;
      try {
        const result = await emitAccountNotificationWebhook({
          url: subscriber.url,
          payload: {
            idempotency_key: idempotencyKey,
            ...envelope,
            subscriber_id: subscriber.subscriberId,
            account_id: subscriber.accountId,
          },
          operationId: `${subscriber.accountId}:${subscriber.subscriberId}:${envelope.notification_id}`,
          notificationType: event.type,
          authentication: webhookAuthentication(subscriber.authentication),
        });
        if (result.delivered) report.delivered += 1;
        else report.failures.push(...result.errors);
      } catch (err) {
        report.failures.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return report;
}
