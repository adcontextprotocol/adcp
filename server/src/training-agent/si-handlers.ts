/**
 * Sponsored Intelligence (SI) task handlers for the training-agent /si tenant.
 *
 * Sandbox implementation: in-memory session store, simulated brand-agent
 * responses. Covers the full four-step SI Chat Protocol lifecycle so learners
 * can demonstrate si_get_offering → si_initiate_session → si_send_message →
 * si_terminate_session in a self-contained sandbox.
 *
 * All responses conform to the canonical SI schemas in
 * static/schemas/source/sponsored-intelligence/*.json.
 */

import { randomUUID } from 'node:crypto';
import type { ToolArgs, TrainingContext } from './types.js';

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SiSandboxSession {
  session_id: string;
  brand_name: string;
  offering_id?: string;
  turns: number;
  status: 'active' | 'terminated';
  principal: string;
}

// Sessions are marked terminated but retained so the SESSION_ENDED error path
// in si_send_message is reachable (si_terminate_session must not delete).
const sessions = new Map<string, SiSandboxSession>();

function makeSessionId(): string {
  return `si_sandbox_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// si_get_offering
// ---------------------------------------------------------------------------

const SANDBOX_OFFERINGS: Record<string, Record<string, unknown>> = {
  'offer_sandbox_001': {
    offering_id: 'offer_sandbox_001',
    title: 'BrandCo AI Chat Experience',
    summary: 'Conversational brand experience showcasing BrandCo\'s AI-powered product discovery. Engage users in natural product conversations with catalog integration and seamless checkout handoff.',
    brand: { name: 'BrandCo', domain: 'brandco.sandbox.example' },
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    price_hint: 'from $99',
  },
  'offer_sandbox_002': {
    offering_id: 'offer_sandbox_002',
    title: 'SportsCo Campaign Offer',
    summary: 'SI Chat Protocol experience for athletic gear discovery. Context-aware product recommendations based on sport and activity level.',
    brand: { name: 'SportsCo', domain: 'sportsco.sandbox.example' },
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    price_hint: 'from $189',
  },
};

const SANDBOX_PRODUCTS: Record<string, unknown[]> = {
  'offer_sandbox_001': [
    { product_id: 'prod_alpha', name: 'Alpha Widget', price: '$99.00', url: 'https://brandco.sandbox.example/alpha' },
    { product_id: 'prod_beta', name: 'Beta Widget', price: '$149.00', url: 'https://brandco.sandbox.example/beta' },
  ],
  'offer_sandbox_002': [
    { product_id: 'prod_run', name: 'RunPro X12 Shoes', price: '$189.00' },
    { product_id: 'prod_cycle', name: 'CycleTech Helmet', price: '$299.00' },
  ],
};

export async function handleSiGetOffering(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const offeringId = a.offering_id as string | undefined;
  if (!offeringId) {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'offering_id is required', field: 'offering_id', recovery: 'correctable' } };
  }

  const offering = SANDBOX_OFFERINGS[offeringId];
  const includeProducts = a.include_products === true;
  const productLimit = typeof a.product_limit === 'number' ? Math.min(a.product_limit, 50) : 5;

  if (!offering) {
    const knownIds = Object.keys(SANDBOX_OFFERINGS).join(', ');
    return {
      available: false,
      adcp_error: {
        code: 'NOT_FOUND',
        message: `Offering "${offeringId}" not found in training sandbox. Available sandbox offering IDs: ${knownIds}`,
        field: 'offering_id',
        recovery: 'correctable',
      },
    };
  }

  const result: Record<string, unknown> = {
    available: true,
    offering_token: `st_${offeringId}_sandbox`,
    checked_at: new Date().toISOString(),
    ttl_seconds: 3600,
    offering: { ...offering },
    sandbox: true,
  };

  if (includeProducts) {
    const products = SANDBOX_PRODUCTS[offeringId] ?? [];
    result['matching_products'] = products.slice(0, productLimit);
    result['total_matching'] = products.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// si_initiate_session
// ---------------------------------------------------------------------------

const BRAND_GREETINGS: Record<string, string> = {
  'offer_sandbox_001': "Hi! I'm the BrandCo AI assistant. I'm here to help you explore our product lineup and answer any questions. What are you looking for today?",
  'offer_sandbox_002': "Welcome to SportsCo! I can help you find the perfect athletic gear. Tell me about your sport or activity and I'll show you our top picks.",
};

const DEFAULT_GREETING = "Welcome! I'm a BrandCo sandbox AI agent demonstrating the SI Chat Protocol. I can show you product cards, answer questions about our catalog, and help with checkout. How can I help you today?";

export async function handleSiInitiateSession(args: ToolArgs, ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const intent = a.intent as string | undefined;
  const identity = a.identity as Record<string, unknown> | undefined;

  if (!intent) {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'intent is required', field: 'intent', recovery: 'correctable' } };
  }
  if (!identity || typeof identity['consent_granted'] !== 'boolean') {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'identity.consent_granted (boolean) is required per SI Chat Protocol', field: 'identity.consent_granted', recovery: 'correctable' } };
  }

  const offeringId = a.offering_id as string | undefined;
  const sessionId = makeSessionId();
  const brandName = offeringId === 'offer_sandbox_002' ? 'SportsCo' : 'BrandCo';

  sessions.set(sessionId, {
    session_id: sessionId,
    brand_name: brandName,
    offering_id: offeringId,
    turns: 0,
    status: 'active',
    principal: ctx.principal ?? 'anonymous',
  });

  const greeting = (offeringId && BRAND_GREETINGS[offeringId]) ?? DEFAULT_GREETING;

  return {
    session_id: sessionId,
    session_status: 'active',
    response: {
      message: greeting,
      ui_elements: [
        {
          type: 'text',
          data: { message: `${brandName} is a sponsor. This conversation is an AI-powered brand experience.` },
        },
      ],
    },
    negotiated_capabilities: {
      components: {
        standard: ['text', 'product_card', 'carousel', 'action_button'],
      },
      commerce: { acp_checkout: true },
    },
    sandbox: true,
  };
}

// ---------------------------------------------------------------------------
// si_send_message
// ---------------------------------------------------------------------------

const TURN_RESPONSES: Array<{ message: string; ui_elements: unknown[] }> = [
  {
    message: 'Great question! Let me show you our most popular products.',
    ui_elements: [
      {
        type: 'product_card',
        data: {
          title: 'Alpha Widget',
          price: '$99.00',
          description: 'Our flagship AI-powered widget with adaptive learning.',
          badge: 'Best Seller',
          cta: { label: 'Add to Cart', action: 'acp_checkout' },
        },
      },
    ],
  },
  {
    message: 'Here\'s a comparison of our two most popular options. The Beta Widget has more advanced features — great for power users.',
    ui_elements: [
      {
        type: 'carousel',
        data: {
          title: 'Top Products',
          items: [
            { title: 'Alpha Widget', price: '$99.00', subtitle: 'Best Seller' },
            { title: 'Beta Widget', price: '$149.00', subtitle: 'Power User Pick' },
          ],
        },
      },
    ],
  },
  {
    message: 'Ready to make a purchase? I can hand you off to our checkout flow.',
    ui_elements: [
      {
        type: 'action_button',
        data: {
          label: 'Proceed to Checkout',
          action: 'acp_checkout',
          payload: { product_id: 'prod_alpha', quantity: 1 },
        },
      },
    ],
  },
  {
    message: 'Is there anything else I can help you with? I can show more products, explain features, or get you to checkout.',
    ui_elements: [] as unknown[],
  },
];

export async function handleSiSendMessage(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const sessionId = a.session_id as string | undefined;
  const message = a.message as string | undefined;
  const actionResponse = a.action_response as Record<string, unknown> | undefined;

  if (!sessionId) {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'session_id is required', field: 'session_id', recovery: 'correctable' } };
  }
  if (!message && !actionResponse) {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'Either message or action_response is required', recovery: 'correctable' } };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return { adcp_error: { code: 'NOT_FOUND', message: `Session "${sessionId}" not found. Use si_initiate_session to start a session.`, field: 'session_id', recovery: 'correctable' } };
  }
  if (session.status === 'terminated') {
    return { adcp_error: { code: 'SESSION_ENDED', message: 'This session has been terminated. Use si_initiate_session to start a new session.', field: 'session_id', recovery: 'correctable' } };
  }

  session.turns += 1;
  const turnIndex = Math.min(session.turns - 1, TURN_RESPONSES.length - 1);
  const turnResponse = TURN_RESPONSES[turnIndex];

  // Detect checkout action_response — issue a pending_handoff
  let handoff: Record<string, unknown> | undefined;
  let sessionStatus: string = 'active';

  if (actionResponse && (actionResponse['action'] === 'acp_checkout' || actionResponse['action'] === 'commerce_add_to_cart' || actionResponse['action'] === 'commerce_handoff')) {
    sessionStatus = 'pending_handoff';
    handoff = {
      type: 'transaction',
      intent: {
        action: 'purchase',
        product: { product_id: (actionResponse['payload'] as Record<string, unknown> | undefined)?.['product_id'] ?? 'prod_alpha' },
      },
      context_for_checkout: {
        conversation_summary: `User requested checkout after ${session.turns} message(s) with ${session.brand_name}.`,
        applied_offers: [session.offering_id].filter(Boolean) as string[],
      },
    };
  }

  return {
    session_id: sessionId,
    session_status: sessionStatus,
    response: {
      message: turnResponse?.message ?? 'Thank you! Is there anything else I can help you with?',
      ui_elements: turnResponse?.ui_elements ?? [],
    },
    ...(handoff && { handoff }),
    sandbox: true,
  };
}

// ---------------------------------------------------------------------------
// si_terminate_session
// ---------------------------------------------------------------------------

function terminateSessionStatus(reason: string): string {
  return (reason === 'handoff_transaction' || reason === 'handoff_complete') ? 'complete' : 'terminated';
}

export async function handleSiTerminateSession(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const sessionId = a.session_id as string | undefined;
  const reason = a.reason as string | undefined;

  if (!sessionId) {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'session_id is required', field: 'session_id', recovery: 'correctable' } };
  }
  if (!reason) {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'reason is required', field: 'reason', recovery: 'correctable' } };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    // Naturally idempotent — already terminated or never existed.
    return {
      terminated: true,
      session_id: sessionId,
      session_status: terminateSessionStatus(reason),
      reason,
      sandbox: true,
    };
  }

  if (session.status === 'terminated') {
    // Already terminated — return the same terminal state.
    return {
      terminated: true,
      session_id: sessionId,
      session_status: terminateSessionStatus(reason),
      reason,
      turns_completed: session.turns,
      sandbox: true,
    };
  }

  // Mark terminated but keep in map so si_send_message returns SESSION_ENDED.
  session.status = 'terminated';

  return {
    terminated: true,
    session_id: sessionId,
    session_status: terminateSessionStatus(reason),
    reason,
    turns_completed: session.turns,
    sandbox: true,
  };
}

// ---------------------------------------------------------------------------
// sync_catalogs
// ---------------------------------------------------------------------------

export async function handleSyncCatalogs(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const catalogId = a.catalog_id as string | undefined;
  const items = a.items as unknown[] | undefined;
  const operationType = a.operation_type as string | undefined;

  if (!catalogId) {
    return { adcp_error: { code: 'MISSING_REQUIRED', message: 'catalog_id is required', field: 'catalog_id', recovery: 'correctable' } };
  }

  const itemCount = Array.isArray(items) ? items.length : 0;

  return {
    synced: true,
    catalog_id: catalogId,
    operation_type: operationType ?? 'upsert',
    items_synced: itemCount,
    sandbox: true,
  };
}
