/**
 * /si tenant — Sponsored Intelligence specialism.
 *
 * Simulates the BRAND-AGENT side of the SI lifecycle so a learner can
 * practice as the HOST: get an offering, initiate a session, exchange
 * messages, and terminate. The training brand is Nova Brands (character
 * bible, summer collection fixture).
 *
 * All four SI tools ride customTools because the SDK's DecisioningPlatform
 * interface has no `sponsoredIntelligence` field yet. They ARE in AdcpToolMap
 * (area: 'si') — the merge-seam comment in brand.ts describes the same
 * pattern for update_rights / creative_approval.
 *
 * Session state is in-memory per process. Acceptable for the shared sandbox:
 * session IDs are training-scoped and not persisted across restarts.
 */

import { z } from 'zod';
import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingSiPlatform } from '../v6-si-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { customToolFor } from './custom-tool-helper.js';
import type { ToolArgs, TrainingContext } from '../types.js';

const TENANT_ID = 'si';

const TRAINING_BRAND = {
  name: 'Nova Brands',
  domain: 'novabrands.example',
  offering_id: 'nova-summer-2026',
  product_title: 'Nova Summer Collection',
} as const;

const activeSessions = new Map<string, { turnCount: number; terminated: boolean }>();

const CONTEXT_REF = z.any().optional();

const SI_GET_OFFERING_SCHEMA = {
  offering_id: z.string(),
  intent: z.string().optional(),
  include_products: z.boolean().optional(),
  product_limit: z.number().int().min(1).max(50).optional(),
  context: CONTEXT_REF,
  ext: z.any().optional(),
};

const SI_INITIATE_SESSION_SCHEMA = {
  idempotency_key: z.string().min(16).max(255).regex(/^[A-Za-z0-9_.:-]{16,255}$/),
  intent: z.string(),
  identity: z.object({}).passthrough(),
  media_buy_id: z.string().optional(),
  placement: z.string().optional(),
  offering_id: z.string().optional(),
  supported_capabilities: z.object({}).passthrough().optional(),
  offering_token: z.string().optional(),
  context: CONTEXT_REF,
  ext: z.any().optional(),
};

const SI_SEND_MESSAGE_SCHEMA = {
  idempotency_key: z.string().min(16).max(255).regex(/^[A-Za-z0-9_.:-]{16,255}$/),
  session_id: z.string(),
  message: z.string().optional(),
  action_response: z.object({}).passthrough().optional(),
  context: CONTEXT_REF,
  ext: z.any().optional(),
};

const SI_TERMINATE_SESSION_SCHEMA = {
  session_id: z.string(),
  reason: z.enum([
    'handoff_transaction',
    'handoff_complete',
    'user_exit',
    'session_timeout',
    'host_terminated',
  ]),
  termination_context: z.object({}).passthrough().optional(),
  context: CONTEXT_REF,
  ext: z.any().optional(),
};

function makeSessionId(): string {
  return `si_sess_${crypto.randomUUID()}`;
}

export function buildSiTenantConfig(host: string): {
  tenantId: string;
  config: TenantConfig;
} {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — sponsored intelligence',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingSiPlatform() as any,
      serverOptions: {
        customTools: {
          si_get_offering: customToolFor(
            'si_get_offering',
            'Get offering details and availability before initiating a session.',
            SI_GET_OFFERING_SCHEMA,
            async (args: ToolArgs, _ctx: TrainingContext) => {
              const p = args as Record<string, unknown>;
              const includeProducts = Boolean(p['include_products'] ?? false);
              const offeringId = String(p['offering_id'] ?? TRAINING_BRAND.offering_id).slice(0, 128);
              const tokenSuffix = offeringId.replace(/[^a-z0-9]/gi, '_');
              return {
                available: true,
                offering_token: `otk_${crypto.randomUUID()}_${tokenSuffix}`,
                offering: {
                  offering_id: offeringId,
                  title: TRAINING_BRAND.product_title,
                  summary:
                    'Discover the latest Nova summer styles — conversational shopping powered by Sponsored Intelligence.',
                },
                ...(includeProducts && {
                  matching_products: [
                    {
                      product_id: 'nova-sun-dress-001',
                      name: 'Nova Sun Dress',
                      price: '79.00',
                      currency: 'USD',
                    },
                    {
                      product_id: 'nova-linen-blazer-002',
                      name: 'Nova Linen Blazer',
                      price: '129.00',
                      currency: 'USD',
                    },
                  ],
                }),
              };
            },
          ),

          si_initiate_session: customToolFor(
            'si_initiate_session',
            'Start a conversational session with a brand agent.',
            SI_INITIATE_SESSION_SCHEMA,
            async (args: ToolArgs, _ctx: TrainingContext) => {
              const p = args as Record<string, unknown>;
              const sessionId = makeSessionId();
              activeSessions.set(sessionId, { turnCount: 0, terminated: false });
              const intent = String(p['intent'] ?? 'browse').slice(0, 200);
              return {
                session_id: sessionId,
                session_status: 'active',
                session_ttl_seconds: 300,
                negotiated_capabilities: {
                  modalities: { conversational: true },
                  components: {
                    standard: ['text', 'link', 'product_card', 'action_button'],
                  },
                },
                response: {
                  message: `Hi! I'm ${TRAINING_BRAND.name}'s AI. You mentioned: "${intent}". I'd love to help you find the perfect piece from our summer collection — what style are you looking for?`,
                  ui_elements: [
                    {
                      type: 'product_card',
                      product_id: 'nova-sun-dress-001',
                      title: 'Nova Sun Dress',
                      price: '79.00',
                      currency: 'USD',
                    },
                  ],
                },
              };
            },
          ),

          si_send_message: customToolFor(
            'si_send_message',
            'Send a message to an active brand agent session.',
            SI_SEND_MESSAGE_SCHEMA,
            async (args: ToolArgs, _ctx: TrainingContext) => {
              const p = args as Record<string, unknown>;
              const sessionId = String(p['session_id'] ?? '');
              const session = activeSessions.get(sessionId);
              if (!session) {
                return {
                  errors: [
                    {
                      code: 'SESSION_NOT_FOUND',
                      message:
                        'SI session not found or expired. Initiate a new session via si_initiate_session.',
                      recovery: 'correctable',
                    },
                  ],
                };
              }
              if (session.terminated) {
                return {
                  errors: [
                    {
                      code: 'SESSION_TERMINATED',
                      message:
                        'SI session has already been terminated. Initiate a new session via si_initiate_session.',
                      recovery: 'correctable',
                    },
                  ],
                };
              }
              session.turnCount++;
              const msg = String(p['message'] ?? '').slice(0, 200);
              return {
                session_id: sessionId,
                session_status: 'active',
                response: {
                  message:
                    session.turnCount === 1
                      ? `Great question! Our ${TRAINING_BRAND.product_title} has something for every style. Here are some popular picks — would you like to see more or go straight to checkout?`
                      : `Thanks for sharing more context: "${msg || '(no message)'}". Based on that, I'd recommend our Nova Linen Blazer — it's our most versatile summer piece. Want details or would you like to proceed to checkout?`,
                  ui_elements: [
                    {
                      type: 'action_button',
                      label: 'View full collection',
                      action: 'view_collection',
                    },
                    {
                      type: 'action_button',
                      label: 'Proceed to checkout',
                      action: 'checkout',
                    },
                  ],
                },
              };
            },
          ),

          si_terminate_session: customToolFor(
            'si_terminate_session',
            'End an active brand agent session.',
            SI_TERMINATE_SESSION_SCHEMA,
            async (args: ToolArgs, _ctx: TrainingContext) => {
              const p = args as Record<string, unknown>;
              const sessionId = String(p['session_id'] ?? '');
              const session = activeSessions.get(sessionId);
              const turns = session?.turnCount ?? 0;
              if (session) {
                session.terminated = true;
              }
              return {
                session_id: sessionId,
                terminated: true,
                session_status: 'terminated',
                termination_summary: {
                  reason: String(p['reason'] ?? 'user_exit'),
                  turns_completed: turns,
                },
              };
            },
          ),
        },
      },
    },
  };
}
