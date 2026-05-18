/**
 * Audience handlers for the training agent.
 *
 * Implements sync_audiences per AdCP schemas. Backed by an in-process
 * per-session store so create_media_buy can verify audience_include /
 * audience_exclude entries reference audiences the buyer registered.
 *
 * Mirrors the catalog-event-handlers.ts pattern (sync_event_sources +
 * findEventSourceInSession) — the rejection contract for unregistered
 * audience_ids is the audience-side sibling of the event-source contract
 * asserted in performance_buy_flow (#4642 / #4654).
 */

import { randomUUID } from 'node:crypto';
import type { TrainingContext, ToolArgs } from './types.js';
import { sessionKeyFromArgs } from './state.js';

// ── Types ────────────────────────────────────────────────────────

interface SyncAudiencesInput extends ToolArgs {
  audiences?: AudienceInput[];
  delete_missing?: boolean;
  idempotency_key?: string;
}

interface AudienceMemberInput {
  external_id?: string;
  hashed_email?: string;
  hashed_phone?: string;
  uids?: { type: string; value: string }[];
  [key: string]: unknown;
}

interface AudienceInput {
  audience_id: string;
  name?: string;
  description?: string;
  audience_type?: 'crm' | 'suppression' | 'lookalike_seed';
  tags?: string[];
  add?: AudienceMemberInput[];
  remove?: AudienceMemberInput[];
  delete?: boolean;
  consent_basis?: string;
}

interface AudienceState {
  audienceId: string;
  name: string;
  sellerId: string;
  uploadedCount: number;
  matchedCount: number;
  status: 'processing' | 'ready' | 'too_small';
  audienceType: string;
  createdAt: string;
  lastSyncedAt: string;
}

const audienceStore = new Map<string, Map<string, AudienceState>>();

function getAudienceMap(sessionKey: string): Map<string, AudienceState> {
  let map = audienceStore.get(sessionKey);
  if (!map) {
    map = new Map();
    audienceStore.set(sessionKey, map);
  }
  return map;
}

/** Look up an audience across every session. Some routes (legacy /mcp vs
 *  v6 /sales/mcp) carry slightly different session keys for the same buyer
 *  brand; a global scan ensures a synced audience is still reachable from
 *  create_media_buy regardless of which surface received the sync. */
export function findAudienceAnywhere(audienceId: string): AudienceState | undefined {
  for (const map of audienceStore.values()) {
    const hit = map.get(audienceId);
    if (hit) return hit;
  }
  return undefined;
}

/** Look up an audience in a specific session, falling back to global scan.
 *  Used by create_media_buy to validate that targeting_overlay.audience_include
 *  and audience_exclude entries reference audiences registered via sync_audiences,
 *  rather than silently accepting phantom ids. */
export function findAudienceInSession(sessionKey: string, audienceId: string): AudienceState | undefined {
  return audienceStore.get(sessionKey)?.get(audienceId) ?? findAudienceAnywhere(audienceId);
}

/** Exported for testing */
export function clearAudienceStore(): void {
  audienceStore.clear();
}

// ── Shared schema fragment ───────────────────────────────────────

const ACCOUNT_REF_SCHEMA = {
  type: 'object',
  oneOf: [
    { properties: { account_id: { type: 'string' } }, required: ['account_id'] },
    {
      properties: {
        brand: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] },
        operator: { type: 'string' },
        sandbox: { type: 'boolean' },
      },
      required: ['brand'],
    },
  ],
};

// ── Tool definition ─────────────────────────────────────────────

export const AUDIENCE_TOOLS = [
  {
    name: 'sync_audiences',
    description: 'Manage CRM-based audiences on an account with upsert semantics. Existing audiences matched by audience_id are updated, new ones are created. Members are specified as delta operations: add appends, remove drops. Omit audiences for discovery-only.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        audiences: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              audience_id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              audience_type: { type: 'string', enum: ['crm', 'suppression', 'lookalike_seed'] },
              tags: { type: 'array', items: { type: 'string' } },
              add: { type: 'array' },
              remove: { type: 'array' },
              delete: { type: 'boolean' },
              consent_basis: { type: 'string' },
            },
            required: ['audience_id'],
          },
          minItems: 1,
        },
        delete_missing: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['account', 'idempotency_key'],
    },
  },
];

// ── Handler implementation ──────────────────────────────────────

export async function handleSyncAudiences(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncAudiencesInput;

  if (!req.account) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'account is required' }],
    };
  }

  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const audiences = getAudienceMap(sessionKey);
  const now = new Date().toISOString();

  // Discovery mode — return existing audiences without mutation.
  if (!req.audiences) {
    const existing = Array.from(audiences.values()).map(a => ({
      audience_id: a.audienceId,
      name: a.name,
      seller_id: a.sellerId,
      action: 'unchanged',
      status: a.status,
      uploaded_count: 0,
      total_uploaded_count: a.uploadedCount,
      matched_count: a.matchedCount,
      ...(a.uploadedCount > 0 && {
        effective_match_rate: a.matchedCount / a.uploadedCount,
      }),
      last_synced_at: a.lastSyncedAt,
    }));
    return { audiences: existing };
  }

  const results: Record<string, unknown>[] = [];

  for (const input of req.audiences) {
    if (!input.audience_id) {
      results.push({
        audience_id: 'unknown',
        action: 'failed',
        errors: [{ code: 'INVALID_REQUEST', message: 'audience_id is required' }],
      });
      continue;
    }

    const existing = audiences.get(input.audience_id);

    if (input.delete === true) {
      if (existing) audiences.delete(input.audience_id);
      results.push({
        audience_id: input.audience_id,
        action: 'deleted',
      });
      continue;
    }

    const uploadedThisCall = input.add?.length ?? 0;
    // Simulate ~70% match rate for testing.
    const matchedThisCall = Math.floor(uploadedThisCall * 0.7);
    const totalUploaded = (existing?.uploadedCount ?? 0) + uploadedThisCall;
    const totalMatched = (existing?.matchedCount ?? 0) + matchedThisCall;
    // Mirror sales-platform capabilities.audience_targeting.minimum_audience_size.
    const minimumSize = 100;
    const status: AudienceState['status'] = totalMatched === 0
      ? 'processing'
      : totalMatched < minimumSize ? 'too_small' : 'ready';

    const state: AudienceState = {
      audienceId: input.audience_id,
      name: input.name ?? existing?.name ?? input.audience_id,
      sellerId: existing?.sellerId ?? `aud_${randomUUID().slice(0, 8)}`,
      uploadedCount: totalUploaded,
      matchedCount: totalMatched,
      status,
      audienceType: input.audience_type ?? existing?.audienceType ?? 'crm',
      createdAt: existing?.createdAt ?? now,
      lastSyncedAt: now,
    };

    audiences.set(input.audience_id, state);

    const result: Record<string, unknown> = {
      audience_id: state.audienceId,
      name: state.name,
      seller_id: state.sellerId,
      action: existing ? 'updated' : 'created',
      status: state.status,
      uploaded_count: uploadedThisCall,
      total_uploaded_count: state.uploadedCount,
      matched_count: state.matchedCount,
      last_synced_at: state.lastSyncedAt,
    };

    if (state.uploadedCount > 0) {
      result.effective_match_rate = state.matchedCount / state.uploadedCount;
    }
    if (state.status === 'too_small') {
      result.minimum_size = minimumSize;
    }

    results.push(result);
  }

  return { audiences: results };
}
