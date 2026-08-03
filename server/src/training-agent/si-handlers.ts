/**
 * Sponsored Intelligence (SI) task handlers for the training-agent /si tenant.
 *
 * Sandbox implementation: in-memory session store, simulated brand-agent
 * responses. Covers the full four-step SI Chat Protocol lifecycle so learners
 * can demonstrate si_get_offering → si_initiate_session → si_send_message →
 * si_terminate_session in a self-contained sandbox.
 *
 * Responses conform to the canonical 3.1.8 SI schemas:
 *   - si-get-offering-response.json (required: available; includes offering_token)
 *   - si-initiate-session-response.json (required: session_id, session_status)
 *   - si-send-message-response.json (required: session_id, session_status)
 *   - si-terminate-session-response.json (required: session_id, terminated)
 *   - si-ui-element.json (types: text, product_card, carousel, action_button)
 *   - si-session-status.json (enum: active, pending_handoff, complete, terminated)
 *
 * sync_catalogs follows canonical media-buy/sync-catalogs-request.json shape:
 *   request requires idempotency_key + account; catalogs[] optional (omit = discovery).
 *   response returns catalogs[] with per-catalog action/item_count results.
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
  // Stored on first termination so repeated calls return the identical result.
  terminalResult?: unknown;
}

// Sessions are marked terminated but retained so the SESSION_TERMINATED error
// path in si_send_message is reachable (si_terminate_session must not delete).
const sessions = new Map<string, SiSandboxSession>();

export function clearSiSessions(): void {
  sessions.clear();
}

function makeSessionId(): string {
  return `si_sandbox_${randomUUID()}`;
}

// Resolve offering_id from a token in the form `tok_${offeringId}_sandbox`.
function offeringIdFromToken(token: string): string | undefined {
  const m = /^tok_(.+)_sandbox$/.exec(token);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// si_get_offering
// ---------------------------------------------------------------------------

const SANDBOX_OFFERINGS: Record<string, Record<string, unknown>> = {
  'offer_sandbox_001': {
    offering_id: 'offer_sandbox_001',
    title: 'BrandCo AI Chat Experience',
    summary: 'Conversational brand experience showcasing AI-powered product discovery with catalog integration and seamless checkout handoff.',
    tagline: 'Discover. Converse. Buy.',
    brand: { name: 'BrandCo', domain: 'brandco.sandbox.example' },
    availability_status: 'available',
    price_hint: 'from $99',
    products: [
      { product_id: 'prod_alpha', name: 'Alpha Widget', price: '$99.00', url: 'https://brandco.sandbox.example/alpha', availability_summary: 'In stock' },
      { product_id: 'prod_beta', name: 'Beta Widget', price: '$149.00', url: 'https://brandco.sandbox.example/beta', availability_summary: 'In stock' },
    ],
    supported_capabilities: {
      rich_cards: true,
      product_carousels: true,
      action_buttons: true,
      commerce_handoff: true,
    },
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  },
  'offer_sandbox_002': {
    offering_id: 'offer_sandbox_002',
    title: 'SportsCo Campaign Offer',
    summary: 'Context-aware product recommendations based on sport and activity level.',
    tagline: 'Gear Up. Perform Better.',
    brand: { name: 'SportsCo', domain: 'sportsco.sandbox.example' },
    availability_status: 'available',
    price_hint: 'from $189',
    products: [
      { product_id: 'prod_run', name: 'RunPro X12 Shoes', price: '$189.00', availability_summary: 'In stock' },
      { product_id: 'prod_cycle', name: 'CycleTech Helmet', price: '$299.00', availability_summary: 'In stock' },
    ],
    supported_capabilities: {
      rich_cards: true,
      product_carousels: true,
      action_buttons: true,
      commerce_handoff: false,
    },
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  },
};

export async function handleSiGetOffering(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const offeringId = a.offering_id as string | undefined;
  if (!offeringId) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'offering_id is required', field: 'offering_id', recovery: 'correctable' }] };
  }

  const offeringData = SANDBOX_OFFERINGS[offeringId];
  if (!offeringData) {
    const knownIds = Object.keys(SANDBOX_OFFERINGS).join(', ');
    return {
      errors: [{
        code: 'NOT_FOUND',
        message: `Offering "${offeringId}" not found in training sandbox. Available sandbox offering IDs: ${knownIds}`,
        field: 'offering_id',
        recovery: 'correctable',
      }],
    };
  }

  const includeProducts = a.include_products === true;
  const productLimit = typeof a.product_limit === 'number' ? Math.min(a.product_limit, 50) : 5;

  const offering = { ...offeringData } as Record<string, unknown>;
  if (!includeProducts) {
    delete offering['products'];
  } else if (Array.isArray(offering['products'])) {
    offering['products'] = (offering['products'] as unknown[]).slice(0, productLimit);
  }

  const matchingProducts = includeProducts && Array.isArray(offeringData['products'])
    ? (offeringData['products'] as unknown[]).slice(0, productLimit)
    : undefined;

  return {
    available: true,
    offering_token: `tok_${offeringId}_sandbox`,
    ttl_seconds: 3600,
    checked_at: new Date().toISOString(),
    offering,
    ...(matchingProducts && { matching_products: matchingProducts }),
    sandbox: true,
  };
}

// ---------------------------------------------------------------------------
// si_initiate_session
// ---------------------------------------------------------------------------

const BRAND_GREETINGS: Record<string, string> = {
  'offer_sandbox_001': "Hi! I'm the BrandCo AI assistant. I'm here to help you explore our product lineup and answer any questions. What are you looking for today?",
  'offer_sandbox_002': "Welcome to SportsCo! I can help you find the perfect athletic gear. Tell me about your sport or activity and I'll show you our top picks.",
};

const DEFAULT_GREETING = "Welcome! I'm a sandbox AI brand agent demonstrating the SI Chat Protocol. I can show you product cards, answer questions about our catalog, and help with checkout. How can I help you today?";

export async function handleSiInitiateSession(args: ToolArgs, ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const intent = a.intent as string | undefined;
  const identity = a.identity as Record<string, unknown> | undefined;

  if (!intent) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'intent is required', field: 'intent', recovery: 'correctable' }] };
  }
  if (!identity || typeof identity['consent_granted'] !== 'boolean') {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'identity.consent_granted (boolean) is required per SI Chat Protocol', field: 'identity.consent_granted', recovery: 'correctable' }] };
  }

  // offering_token is authoritative when present: validate it and extract the
  // resolved offering_id so the correct brand fixture is always selected.
  const offeringToken = a.offering_token as string | undefined;
  let resolvedOfferingId: string | undefined;

  if (offeringToken) {
    const extractedId = offeringIdFromToken(offeringToken);
    if (!extractedId || !SANDBOX_OFFERINGS[extractedId]) {
      return {
        errors: [{
          code: 'INVALID_OFFERING_TOKEN',
          message: `offering_token "${offeringToken}" is not a valid sandbox token. Call si_get_offering first and pass the returned offering_token here.`,
          field: 'offering_token',
          recovery: 'correctable',
        }],
      };
    }
    resolvedOfferingId = extractedId;
  } else {
    // No token: fall back to direct offering_id (discovery path without a prior si_get_offering call).
    resolvedOfferingId = a.offering_id as string | undefined;
  }

  const sessionId = makeSessionId();
  const brandName = resolvedOfferingId === 'offer_sandbox_002' ? 'SportsCo' : 'BrandCo';

  sessions.set(sessionId, {
    session_id: sessionId,
    brand_name: brandName,
    offering_id: resolvedOfferingId,
    turns: 0,
    status: 'active',
    principal: ctx.principal ?? 'anonymous',
  });

  const greeting = (resolvedOfferingId && BRAND_GREETINGS[resolvedOfferingId]) ?? DEFAULT_GREETING;

  return {
    session_id: sessionId,
    session_status: 'active',
    response: {
      message: greeting,
      ui_elements: [
        {
          type: 'text',
          data: {
            message: `${brandName} is a sponsor. This conversation is an AI-powered brand experience.`,
          },
        },
      ],
    },
    negotiated_capabilities: {
      rich_cards: true,
      product_carousels: true,
      action_buttons: true,
      commerce_handoff: brandName === 'BrandCo',
    },
    session_ttl_seconds: 1800,
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
          subtitle: 'Our flagship product',
          price: '$99.00',
          description: 'AI-powered widget with adaptive learning.',
          badge: 'Best Seller',
          cta: { label: 'Add to Cart', action: 'commerce_add_to_cart' },
        },
      },
    ],
  },
  {
    message: "Here's a comparison of our two most popular options. The Beta Widget has more advanced features — great for power users.",
    ui_elements: [
      {
        type: 'carousel',
        data: {
          title: 'Compare Products',
          items: [
            { product_id: 'prod_alpha', title: 'Alpha Widget', price: '$99.00', badge: 'Best Seller' },
            { product_id: 'prod_beta', title: 'Beta Widget', price: '$149.00', badge: 'Power User Pick' },
          ],
        },
      },
    ],
  },
  {
    message: "Ready to make a purchase? I can hand you off to our checkout flow. Just say \"buy\" or click the checkout button.",
    ui_elements: [
      {
        type: 'action_button',
        data: {
          label: 'Proceed to Checkout',
          action: 'commerce_handoff',
          payload: { product_id: 'prod_alpha', quantity: 1 },
        },
      },
    ],
  },
  {
    message: 'Is there anything else I can help you with? I can show more products, explain features, or get you to checkout.',
    ui_elements: [],
  },
];

export async function handleSiSendMessage(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const sessionId = a.session_id as string | undefined;
  const message = a.message as string | undefined;
  const actionResponse = a.action_response as Record<string, unknown> | undefined;

  if (!sessionId) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'session_id is required', field: 'session_id', recovery: 'correctable' }] };
  }
  if (!message && !actionResponse) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'Either message or action_response is required', recovery: 'correctable' }] };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return { errors: [{ code: 'NOT_FOUND', message: `Session "${sessionId}" not found. Use si_initiate_session to start a session.`, field: 'session_id', recovery: 'correctable' }] };
  }
  if (session.status === 'terminated') {
    // Canonical si-send-message-response.json requires session_id + session_status
    // even on error. Error code is SESSION_TERMINATED per schema description.
    return {
      session_id: sessionId,
      session_status: 'terminated',
      errors: [{ code: 'SESSION_TERMINATED', message: 'This session has been terminated. Use si_initiate_session to start a new session.', field: 'session_id', recovery: 'correctable' }],
    };
  }

  session.turns += 1;
  const turnIndex = Math.min(session.turns - 1, TURN_RESPONSES.length - 1);
  const turnResponse = TURN_RESPONSES[turnIndex];

  // Detect commerce handoff action
  let handoff: Record<string, unknown> | undefined;
  let sessionStatus: 'active' | 'pending_handoff' = 'active';
  if (actionResponse && (actionResponse['action'] === 'commerce_handoff' || actionResponse['action'] === 'commerce_add_to_cart')) {
    sessionStatus = 'pending_handoff';
    handoff = {
      type: 'transaction',
      intent: {
        action: 'purchase',
        product: { product_id: (actionResponse['payload'] as Record<string, unknown> | undefined)?.['product_id'] ?? 'prod_alpha' },
      },
      context_for_checkout: {
        conversation_summary: 'User expressed intent to purchase after viewing product cards.',
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

export async function handleSiTerminateSession(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const sessionId = a.session_id as string | undefined;
  const reason = a.reason as string | undefined;

  if (!sessionId) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'session_id is required', field: 'session_id', recovery: 'correctable' }] };
  }
  if (!reason) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'reason is required', field: 'reason', recovery: 'correctable' }] };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    // Termination is idempotent — a not-found session_id is treated as already terminated.
    return {
      session_id: sessionId,
      terminated: true,
      session_status: 'terminated',
      reason,
      note: 'Session already terminated or not found.',
      sandbox: true,
    };
  }

  // Already terminated: return the stored terminal result unchanged so repeated
  // calls see the same status/reason/checkout_token and no new UUID is minted.
  if (session.status === 'terminated' && session.terminalResult !== undefined) {
    return session.terminalResult;
  }

  // First termination: build the result, persist it, mark session terminated.
  const sessionStatus = (reason === 'handoff_transaction' || reason === 'handoff_complete')
    ? 'complete'
    : 'terminated';

  const result: Record<string, unknown> = {
    session_id: sessionId,
    terminated: true,
    session_status: sessionStatus,
    reason,
    turns_completed: session.turns,
    sandbox: true,
  };

  if (reason === 'handoff_transaction') {
    result['acp_handoff'] = {
      checkout_url: 'https://brandco.sandbox.example/checkout?sandbox=true',
      checkout_token: `chk_sandbox_${randomUUID()}`,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  // Persist before returning so a concurrent second call sees the stored result.
  session.status = 'terminated';
  session.terminalResult = result;

  return result;
}

// ---------------------------------------------------------------------------
// sync_catalogs — canonical media-buy/sync-catalogs-request.json shape
// ---------------------------------------------------------------------------

export async function handleSyncCatalogs(args: ToolArgs, _ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const catalogs = a.catalogs as Array<Record<string, unknown>> | undefined;

  if (!catalogs || catalogs.length === 0) {
    // Discovery-only call (catalogs omitted): return empty list per schema.
    return { catalogs: [], sandbox: true };
  }

  const results = catalogs.map((cat: Record<string, unknown>) => {
    const items = cat['items'] as unknown[] | undefined;
    return {
      catalog_id: (cat['catalog_id'] as string | undefined) ?? 'unknown',
      action: 'created',
      item_count: Array.isArray(items) ? items.length : 0,
      last_synced_at: new Date().toISOString(),
    };
  });

  return { catalogs: results, sandbox: true };
}
