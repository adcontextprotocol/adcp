/**
 * Sponsored Intelligence (SI) task handlers for the training-agent /si tenant.
 *
 * Sandbox implementation: in-memory session store, simulated brand-agent
 * responses. Covers the full four-step SI Chat Protocol lifecycle so learners
 * can demonstrate si_get_offering → si_initiate_session → si_send_message →
 * si_terminate_session in a self-contained sandbox.
 */

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

const sessions = new Map<string, SiSandboxSession>();

function makeSessionId(): string {
  return `si_sandbox_${Math.random().toString(36).slice(2, 11)}_${Date.now()}`;
}

// ---------------------------------------------------------------------------
// si_get_offering
// ---------------------------------------------------------------------------

const SANDBOX_OFFERINGS: Record<string, object> = {
  'offer_sandbox_001': {
    id: 'offer_sandbox_001',
    title: 'BrandCo AI Chat Experience',
    description: 'Conversational brand experience showcasing BrandCo\'s AI-powered product discovery. Engage users in natural product conversations with catalog integration and seamless checkout handoff.',
    brand: { name: 'BrandCo', domain: 'brandco.sandbox.example' },
    availability: 'available',
    cpc_floor: 0.25,
    context_use: { mode: 'session_context', disclosure_required: true },
    products: [
      { id: 'prod_alpha', title: 'Alpha Widget', price_usd: 99.00, url: 'https://brandco.sandbox.example/alpha' },
      { id: 'prod_beta', title: 'Beta Widget', price_usd: 149.00, url: 'https://brandco.sandbox.example/beta' },
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
    id: 'offer_sandbox_002',
    title: 'SportsCo Campaign Offer',
    description: 'SI Chat Protocol experience for athletic gear discovery. Context-aware product recommendations based on sport and activity level.',
    brand: { name: 'SportsCo', domain: 'sportsco.sandbox.example' },
    availability: 'available',
    cpc_floor: 0.35,
    context_use: { mode: 'session_context', disclosure_required: true },
    products: [
      { id: 'prod_run', title: 'RunPro X12 Shoes', price_usd: 189.00 },
      { id: 'prod_cycle', title: 'CycleTech Helmet', price_usd: 299.00 },
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

  const offering = SANDBOX_OFFERINGS[offeringId];
  const includeProducts = a.include_products === true;
  const productLimit = typeof a.product_limit === 'number' ? Math.min(a.product_limit, 50) : 5;
  if (!offering) {
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

  const result = { ...offering } as Record<string, unknown>;
  if (!includeProducts) {
    delete result['products'];
  } else if (Array.isArray(result['products'])) {
    result['products'] = (result['products'] as unknown[]).slice(0, productLimit);
  }

  return { offering: result };
}

// ---------------------------------------------------------------------------
// si_initiate_session
// ---------------------------------------------------------------------------

const BRAND_GREETINGS: Record<string, string> = {
  'offer_sandbox_001': 'Hi! I\'m the BrandCo AI assistant. I\'m here to help you explore our product lineup and answer any questions. What are you looking for today?',
  'offer_sandbox_002': 'Welcome to SportsCo! I can help you find the perfect athletic gear. Tell me about your sport or activity and I\'ll show you our top picks.',
};

const DEFAULT_GREETING = 'Welcome! I\'m a BrandCo sandbox AI agent demonstrating the SI Chat Protocol. I can show you product cards, answer questions about our catalog, and help with checkout. How can I help you today?';

export async function handleSiInitiateSession(args: ToolArgs, ctx: TrainingContext): Promise<unknown> {
  const a = args as ToolArgs & Record<string, unknown>;
  const intent = a.intent as string | undefined;
  const identity = a.identity as Record<string, unknown> | undefined;

  if (!intent) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'intent is required', field: 'intent', recovery: 'correctable' }] };
  }
  if (!identity) {
    return { errors: [{ code: 'MISSING_REQUIRED', message: 'identity is required', field: 'identity', recovery: 'correctable' }] };
  }

  const offeringId = a.offering_id as string | undefined;
  const sessionId = makeSessionId();
  const brandName = offeringId?.startsWith('offer_sandbox_002') ? 'SportsCo' : 'BrandCo';

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
    brand_name: brandName,
    status: 'active',
    message: {
      role: 'brand_agent',
      content: greeting,
      content_type: 'text',
      ui_elements: [
        {
          type: 'disclosure',
          text: `${brandName} is a sponsor. This conversation is an AI-powered brand experience.`,
        },
      ],
    },
    capabilities: {
      rich_cards: true,
      product_carousels: true,
      action_buttons: true,
      commerce_handoff: true,
    },
    placement: a.placement ?? 'sandbox',
    sandbox: true,
  };
}

// ---------------------------------------------------------------------------
// si_send_message
// ---------------------------------------------------------------------------

const TURN_RESPONSES = [
  {
    content: 'Great question! Let me show you our most popular products.',
    ui_elements: [
      {
        type: 'product_card',
        product_id: 'prod_alpha',
        title: 'Alpha Widget',
        description: 'Our flagship AI-powered widget with adaptive learning.',
        price: '$99.00',
        action_buttons: [
          { id: 'btn_add_cart', label: 'Add to Cart', action: 'commerce_add_to_cart', payload: { product_id: 'prod_alpha' } },
          { id: 'btn_learn_more', label: 'Learn More', action: 'open_url', payload: { url: 'https://brandco.sandbox.example/alpha' } },
        ],
      },
    ],
  },
  {
    content: 'Here\'s a comparison of our two most popular options. The Beta Widget has more advanced features — great for power users.',
    ui_elements: [
      {
        type: 'product_carousel',
        products: [
          { product_id: 'prod_alpha', title: 'Alpha Widget', price: '$99.00', tag: 'Best Seller' },
          { product_id: 'prod_beta', title: 'Beta Widget', price: '$149.00', tag: 'Power User Pick' },
        ],
      },
    ],
  },
  {
    content: 'Ready to make a purchase? I can hand you off to our checkout flow. Just say "buy" or click the checkout button.',
    ui_elements: [
      {
        type: 'action_button',
        id: 'btn_checkout',
        label: 'Proceed to Checkout',
        action: 'commerce_handoff',
        payload: { product_id: 'prod_alpha', quantity: 1 },
      },
    ],
  },
  {
    content: 'Is there anything else I can help you with? I can show more products, explain features, or get you to checkout.',
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
    return { errors: [{ code: 'SESSION_ENDED', message: 'This session has been terminated. Use si_initiate_session to start a new session.', field: 'session_id', recovery: 'correctable' }] };
  }

  session.turns += 1;
  const turnIndex = Math.min(session.turns - 1, TURN_RESPONSES.length - 1);
  const response = TURN_RESPONSES[turnIndex];

  // Detect checkout action_response
  let handoff: Record<string, unknown> | undefined;
  if (actionResponse && (actionResponse['action'] === 'commerce_handoff' || actionResponse['action'] === 'commerce_add_to_cart')) {
    handoff = {
      type: 'commerce',
      action: 'add_to_cart',
      product_id: (actionResponse['payload'] as Record<string, unknown> | undefined)?.['product_id'] ?? 'prod_alpha',
      checkout_url: 'https://brandco.sandbox.example/checkout?sandbox=true',
      note: 'Sandbox commerce handoff — in production this completes via ACP.',
    };
  }

  return {
    session_id: sessionId,
    brand_name: session.brand_name,
    session_status: 'active',
    message: {
      role: 'brand_agent',
      content: response?.content ?? 'Thank you! Is there anything else I can help you with?',
      content_type: 'text',
      ui_elements: response?.ui_elements ?? [],
    },
    turn_number: session.turns,
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
      terminated: true,
      session_id: sessionId,
      reason,
      note: 'Session already terminated or not found.',
      sandbox: true,
    };
  }

  session.status = 'terminated';
  sessions.delete(sessionId);

  return {
    terminated: true,
    session_id: sessionId,
    brand_name: session.brand_name,
    reason,
    turns_completed: session.turns,
    sandbox: true,
  };
}
