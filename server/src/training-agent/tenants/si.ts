/**
 * /si tenant — Sponsored Intelligence (SI Chat Protocol).
 *
 * Exposes the four SI lifecycle tasks (si_get_offering, si_initiate_session,
 * si_send_message, si_terminate_session) via the customTools merge seam.
 * No first-class specialism field exists on DecisioningPlatform for SI yet;
 * all tools ride customTools until the SDK adds `sponsoredIntelligence`.
 *
 * sync_catalogs follows the canonical media-buy/sync-catalogs-request.json shape:
 *   required: idempotency_key, account — enforceIdempotency: true (mutating).
 *   optional: catalogs[] (omit = discovery-only call).
 *
 * si_initiate_session and si_send_message are in MUTATING_TOOLS (idempotency.ts)
 * and carry `enforceIdempotency: true` — the SDK enforces idempotency_key
 * presence and at-most-once execution before the handler is reached.
 */

import { z } from 'zod';
import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingSiPlatform } from '../v6-si-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { customToolFor } from './custom-tool-helper.js';
import { listAccountsTool } from './account-tools.js';
import {
  handleSiGetOffering,
  handleSiInitiateSession,
  handleSiSendMessage,
  handleSiTerminateSession,
  handleSyncCatalogs,
} from '../si-handlers.js';
import type { TrainingContext } from '../types.js';

const TENANT_ID = 'si';

const CONTEXT_REF = z.any().optional();
const EXT_REF = z.any().optional();

// sync_catalogs — canonical media-buy/sync-catalogs-request.json shape.
// Required: idempotency_key, account. Optional: catalogs[] (omit = discovery).
const SYNC_CATALOGS_SCHEMA = {
  idempotency_key: z.string().min(16).max(255),
  account: z.object({
    account_id: z.string().optional(),
    brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
    operator: z.string().optional(),
  }).passthrough(),
  catalogs: z.array(z.object({
    catalog_id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    url: z.string().optional(),
    feed_format: z.string().optional(),
    update_frequency: z.string().optional(),
    items: z.array(z.object({}).passthrough()).optional(),
  }).passthrough()).optional(),
  catalog_ids: z.array(z.string()).optional(),
  delete_missing: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  context: CONTEXT_REF,
  ext: EXT_REF,
};

// si_get_offering — pre-session offering discovery (read-only, no session required)
const SI_GET_OFFERING_SCHEMA = {
  offering_id: z.string(),
  intent: z.string().optional(),
  include_products: z.boolean().optional(),
  product_limit: z.number().int().min(1).max(50).optional(),
  context: CONTEXT_REF,
  ext: EXT_REF,
};

// si_initiate_session — start a conversational brand session (mutating, idempotency enforced)
const SI_INITIATE_SESSION_SCHEMA = {
  idempotency_key: z.string().min(16).max(255),
  intent: z.string(),
  identity: z.object({
    consent_granted: z.boolean(),
    consent_scope: z.array(z.string()).optional(),
    consent_timestamp: z.string().optional(),
    anonymous_session_id: z.string().optional(),
    user: z.object({
      email: z.string().optional(),
      name: z.string().optional(),
      locale: z.string().optional(),
      phone: z.string().optional(),
      shipping_address: z.object({}).passthrough().optional(),
    }).passthrough().optional(),
    privacy_policy_acknowledged: z.object({}).passthrough().optional(),
  }).passthrough(),
  offering_id: z.string().optional(),
  offering_token: z.string().optional(),
  placement: z.string().optional(),
  media_buy_id: z.string().optional(),
  supported_capabilities: z.object({}).passthrough().optional(),
  sponsored_context_receipt: z.object({}).passthrough().optional(),
  account: z.object({
    account_id: z.string().optional(),
    brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
    operator: z.string().optional(),
  }).passthrough().optional(),
  context: CONTEXT_REF,
  ext: EXT_REF,
};

// si_send_message — exchange in an active session (mutating, idempotency enforced)
const SI_SEND_MESSAGE_SCHEMA = {
  idempotency_key: z.string().min(16).max(255),
  session_id: z.string(),
  message: z.string().optional(),
  action_response: z.object({
    action: z.string(),
    payload: z.object({}).passthrough().optional(),
  }).passthrough().optional(),
  sponsored_context_receipt: z.object({}).passthrough().optional(),
  context: CONTEXT_REF,
  ext: EXT_REF,
};

// si_terminate_session — end a session (naturally idempotent on session_id)
const SI_TERMINATE_SESSION_SCHEMA = {
  session_id: z.string(),
  reason: z.enum(['handoff_transaction', 'handoff_complete', 'user_exit', 'session_timeout', 'host_terminated']),
  termination_context: z.object({
    summary: z.string().optional(),
    transaction_intent: z.object({}).passthrough().optional(),
    cause: z.string().optional(),
  }).passthrough().optional(),
  context: CONTEXT_REF,
  ext: EXT_REF,
};

export function buildSiTenantConfig(
  host: string,
  options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {},
): { tenantId: string; config: TenantConfig } {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — sponsored intelligence',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingSiPlatform(options.storyboardCompat) as any,
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),

          sync_catalogs: customToolFor(
            'sync_catalogs',
            'Sync a product catalog to the Sponsored Intelligence platform. Enables brand agents to serve context-aware product recommendations during SI Chat Protocol sessions. Call this before creating SI media buys to ensure catalog richness for creative generation.',
            SYNC_CATALOGS_SCHEMA,
            handleSyncCatalogs,
            {
              annotations: { readOnlyHint: false, idempotentHint: false },
              enforceIdempotency: true,
            },
          ),

          si_get_offering: customToolFor(
            'si_get_offering',
            'Get offering details and availability from a brand agent before initiating an SI Chat Protocol session. Returns offering metadata, supported capabilities, and optionally matching products. Returns an offering_token — pass it to si_initiate_session to thread session continuity and ensure the correct brand fixture is selected.',
            SI_GET_OFFERING_SCHEMA,
            handleSiGetOffering,
            { annotations: { readOnlyHint: true, idempotentHint: true } },
          ),

          si_initiate_session: customToolFor(
            'si_initiate_session',
            'Start an SI Chat Protocol session with a brand agent. Pass the offering_token from si_get_offering to thread offering continuity — the token is authoritative for brand selection. Supply user intent and identity consent. Returns a session_id required for subsequent si_send_message and si_terminate_session calls.',
            SI_INITIATE_SESSION_SCHEMA,
            handleSiInitiateSession,
            {
              annotations: { readOnlyHint: false, idempotentHint: true },
              enforceIdempotency: true,
            },
          ),

          si_send_message: customToolFor(
            'si_send_message',
            'Send a message or action response within an active SI Chat Protocol session. The brand agent replies with conversational content, product cards, carousels, or action buttons. Either message or action_response must be provided. Use idempotency_key to prevent duplicate turns on retry.',
            SI_SEND_MESSAGE_SCHEMA,
            handleSiSendMessage,
            {
              annotations: { readOnlyHint: false, idempotentHint: false },
              enforceIdempotency: true,
            },
          ),

          si_terminate_session: customToolFor(
            'si_terminate_session',
            'Terminate an active SI Chat Protocol session. Naturally idempotent — terminating an already-ended session returns the same terminal state. Provide a reason: user_exit for user-initiated exits, handoff_transaction when routing to checkout, handoff_complete after a successful transaction, host_terminated for policy enforcement.',
            SI_TERMINATE_SESSION_SCHEMA,
            handleSiTerminateSession,
            { annotations: { readOnlyHint: false, idempotentHint: true } },
          ),
        },
      },
    },
  };
}
