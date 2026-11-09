/**
 * `seed_collection` comply_test_controller scenario (training-agent local,
 * 3.3 wire only): change the caller's collection cards so card webhooks and
 * conditional reads can be exercised.
 *
 * Only the closed list a selling agent owns can change (`images`,
 * `sample_content`, `url`, `description`, `season`, `cadence` and
 * `distribution[].followers`); anchored facts stay as adagents.json declares
 * them. Each change fires the event the spec calls for:
 *
 * - `action: "update"`: replace closed-list fields on one or more cards.
 * - `action: "remove"` / `"restore"`: the seller stops / resumes offering a
 *   card (`collection_card.removed` / `collection_card.updated`).
 * - `action: "refresh_followers"`: a follower sweep. Counts whose bounds and
 *   precision are unchanged are not changes and keep their `as_of`; a sweep
 *   that changes any count goes out as one `collection_catalog.bulk_change`,
 *   and a sweep that changes none fires nothing and moves no version.
 *
 * An operation that touches more than 5% of the catalog or more than 100
 * cards, whichever is smaller (and always more than one card), goes out as
 * one `collection_catalog.bulk_change` instead of per-card events.
 *
 * params:
 *   { action: "update", collections: [{ publisher_domain, collection_id, fields: { ... } }] }
 *   { action: "remove", collections: [{ publisher_domain, collection_id, removal_reason? }] }
 *   { action: "restore", collections: [{ publisher_domain, collection_id }] }
 *   { action: "refresh_followers", followers: [{ publisher_domain, collection_id,
 *       distribution_publisher_domain, lower_bound, upper_bound, precision, as_of? }] }
 */

import type { TrainingContext } from '../types.js';
import {
  CLOSED_LIST_FIELDS,
  cardFor,
  catalogHasKey,
  catalogSize,
  keyOf,
  patchCard,
  refreshFollowers,
  removeCard,
  supportsCollections33,
  unfilteredCollectionsVersion,
  type AudienceSize,
  type ClosedListField,
  type CollectionKey,
} from './card-catalog.js';
import { deliverCardEvents, type CardEvent } from './card-webhooks.js';

export const SEED_COLLECTION_SCENARIO = 'seed_collection';

const CADENCES = new Set(['daily', 'weekly', 'monthly', 'seasonal', 'event', 'irregular']);
const REMOVAL_REASONS = new Set(['withdrawn', 'cancellation', 'expired', 'depublication', 'policy_takedown']);

type Failure = { success: false; error: string; error_detail: string };

function invalid(detail: string): Failure {
  return { success: false, error: 'INVALID_PARAMS', error_detail: detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bulk when one operation touches more than this many cards. */
export function bulkThreshold(catalogCards: number): number {
  return Math.max(1, Math.min(Math.floor(catalogCards * 0.05), 100));
}

function parseKey(entry: unknown, path: string): CollectionKey | Failure {
  if (!isRecord(entry) || typeof entry.publisher_domain !== 'string' || typeof entry.collection_id !== 'string') {
    return invalid(`${path} requires publisher_domain and collection_id`);
  }
  const key = { publisher_domain: entry.publisher_domain, collection_id: entry.collection_id };
  if (!catalogHasKey(key)) return invalid(`${path}: this seller has no collection ${entry.publisher_domain}/${entry.collection_id}`);
  return key;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function validateFields(fields: unknown, path: string): Partial<Record<ClosedListField, unknown>> | Failure {
  if (!isRecord(fields) || Object.keys(fields).length === 0) return invalid(`${path} must name at least one field`);
  const out: Partial<Record<ClosedListField, unknown>> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!(CLOSED_LIST_FIELDS as readonly string[]).includes(name)) {
      return invalid(`${path}.${name}: only ${CLOSED_LIST_FIELDS.join(', ')} can change on a seller's copy; other collection facts are anchored to adagents.json (followers change through refresh_followers)`);
    }
    if (value !== null) {
      if ((name === 'images' || name === 'sample_content')
        && (!Array.isArray(value) || value.length < 1 || value.length > 10 || !value.every(isRecord))) {
        return invalid(`${path}.${name} must be an array of 1 to 10 assets`);
      }
      if (name === 'images' && !(value as Array<Record<string, unknown>>).every(asset => (
        asset.asset_type === 'image' && isHttpsUrl(asset.url)
        && Number.isInteger(asset.width) && Number.isInteger(asset.height)
      ))) return invalid(`${path}.images entries need asset_type "image", an https url, width and height`);
      if (name === 'sample_content' && !(value as Array<Record<string, unknown>>).every(asset => (
        asset.asset_type === 'published_post' && (isHttpsUrl(asset.post_url) || typeof asset.platform_post_id === 'string')
      ))) return invalid(`${path}.sample_content entries need asset_type "published_post" and a post_url or platform_post_id`);
      if (name === 'url' && !isHttpsUrl(value)) return invalid(`${path}.url must be an https URL`);
      if ((name === 'description' || name === 'season') && (typeof value !== 'string' || value.length === 0)) {
        return invalid(`${path}.${name} must be a non-empty string`);
      }
      if (name === 'cadence' && !CADENCES.has(value as string)) return invalid(`${path}.cadence is not a collection cadence`);
    }
    out[name as ClosedListField] = value;
  }
  return out;
}

function parseCount(entry: Record<string, unknown>, path: string): AudienceSize | Failure {
  const { lower_bound: lower, upper_bound: upper, precision, as_of: asOf } = entry;
  if (!Number.isInteger(lower) || !Number.isInteger(upper) || (lower as number) < 0 || (upper as number) < (lower as number)) {
    return invalid(`${path} needs integer lower_bound <= upper_bound`);
  }
  if (precision !== 'exact' && precision !== 'approximate') return invalid(`${path}.precision must be exact or approximate`);
  if (precision === 'exact' && lower !== upper) return invalid(`${path}: an exact count has lower_bound equal to upper_bound`);
  if (asOf !== undefined && (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf)))) {
    return invalid(`${path}.as_of must be a date-time`);
  }
  return {
    lower_bound: lower as number,
    upper_bound: upper as number,
    precision,
    ...(typeof asOf === 'string' && { as_of: asOf }),
  };
}

function failed(value: unknown): value is Failure {
  return isRecord(value) && value.success === false;
}

export async function handleSeedCollection(rawArgs: Record<string, unknown>, ctx: TrainingContext): Promise<object> {
  if (!supportsCollections33(ctx.servedAdcpVersion)) {
    return {
      success: false,
      error: 'UNKNOWN_SCENARIO',
      error_detail: 'seed_collection drives experimental 3.3 collection cards; pin the 3.3 preview to use it.',
    };
  }
  const params = isRecord(rawArgs.params) ? rawArgs.params : {};
  const principal = ctx.principal;
  const action = params.action;
  const startVersion = unfilteredCollectionsVersion(principal);
  const startSize = catalogSize(principal);
  const events: CardEvent[] = [];
  const changedKeys: CollectionKey[] = [];
  let previous = startVersion;
  const record = (event: Omit<CardEvent, 'previousVersion' | 'version'> & Record<string, unknown>, key: CollectionKey) => {
    const version = unfilteredCollectionsVersion(principal);
    events.push({ ...event, previousVersion: previous, version } as CardEvent);
    changedKeys.push(key);
    previous = version;
  };

  if (action === 'update' || action === 'remove' || action === 'restore') {
    const entries = params.collections;
    if (!Array.isArray(entries) || entries.length === 0) return invalid(`seed_collection ${action} requires params.collections`);
    const parsed: Array<{ key: CollectionKey; fields?: Partial<Record<ClosedListField, unknown>>; reason?: string }> = [];
    for (const [index, entry] of entries.entries()) {
      const path = `params.collections[${index}]`;
      const key = parseKey(entry, path);
      if (failed(key)) return key;
      if (action === 'update') {
        const fields = validateFields((entry as Record<string, unknown>).fields, `${path}.fields`);
        if (failed(fields)) return fields;
        parsed.push({ key, fields });
      } else if (action === 'remove') {
        const reason = (entry as Record<string, unknown>).removal_reason;
        if (reason !== undefined && !REMOVAL_REASONS.has(reason as string)) return invalid(`${path}.removal_reason is not a removal reason`);
        parsed.push({ key, reason: (reason as string | undefined) ?? 'withdrawn' });
      } else {
        parsed.push({ key });
      }
    }
    for (const { key, fields, reason } of parsed) {
      if (action === 'remove') {
        if (removeCard(principal, key, reason!)) {
          record({ type: 'collection_card.removed', key, removalReason: reason }, key);
        }
        continue;
      }
      const wasOffered = cardFor(principal, key) !== undefined;
      if (action === 'restore' && wasOffered) continue;
      const result = patchCard(principal, key, fields ?? {});
      if (!result || (!result.reentered && result.changedFields.length === 0)) continue;
      record({
        type: 'collection_card.updated',
        card: cardFor(principal, key)!,
        ...(!result.reentered && { changedFields: result.changedFields }),
      }, key);
    }
  } else if (action === 'refresh_followers') {
    const entries = params.followers;
    if (!Array.isArray(entries) || entries.length === 0) return invalid('seed_collection refresh_followers requires params.followers');
    const nowIso = new Date().toISOString();
    const parsed: Array<{ key: CollectionKey; platform: string; count: AudienceSize }> = [];
    for (const [index, entry] of entries.entries()) {
      const path = `params.followers[${index}]`;
      const key = parseKey(entry, path);
      if (failed(key)) return key;
      const platform = (entry as Record<string, unknown>).distribution_publisher_domain;
      if (typeof platform !== 'string') return invalid(`${path}.distribution_publisher_domain is required`);
      const count = parseCount(entry as Record<string, unknown>, path);
      if (failed(count)) return count;
      parsed.push({ key, platform, count });
    }
    const touched = new Map<string, CollectionKey>();
    for (const { key, platform, count } of parsed) {
      const changed = refreshFollowers(principal, key, platform, count, nowIso);
      if (changed === undefined) return invalid(`${keyOf(key).replace('\u0000', '/')} has no distribution entry on ${platform}`);
      if (changed) touched.set(keyOf(key), key);
    }
    if (touched.size > 0) {
      // A follower sweep always goes out as one bulk event.
      events.push({
        type: 'collection_catalog.bulk_change',
        summary: `Follower counts refreshed on ${touched.size} collection card${touched.size === 1 ? '' : 's'}`,
        affectedCount: touched.size,
        previousVersion: startVersion,
        version: unfilteredCollectionsVersion(principal),
      });
      changedKeys.push(...touched.values());
    }
  } else {
    return invalid('seed_collection requires params.action: update, remove, restore or refresh_followers');
  }

  // One operation that touches more cards than the threshold is one bulk event.
  let outgoing = events;
  if (events.length > bulkThreshold(startSize)
    && events.every(event => event.type !== 'collection_catalog.bulk_change')) {
    outgoing = [{
      type: 'collection_catalog.bulk_change',
      summary: `${events.length} collection cards changed in one operation`,
      affectedCount: events.length,
      previousVersion: startVersion,
      version: unfilteredCollectionsVersion(principal),
    }];
  }
  const report = await deliverCardEvents(principal, outgoing);
  return {
    success: report.failures.length === 0,
    action,
    changed: changedKeys,
    collections_version: unfilteredCollectionsVersion(principal),
    ...report,
    ...(report.failures.length > 0 && { error: 'DELIVERY_FAILED', error_detail: report.failures.slice(0, 3).join('; ') }),
  };
}
