#!/usr/bin/env node

/**
 * Reference fixture publisher for buyer-side storyboard testing.
 *
 * Reads a buyer storyboard YAML (interaction_model: media_buy_buyer),
 * extracts the fixtures.fixture_publisher block, and boots an HTTP
 * server that serves AdCP tool endpoints with canned responses.
 *
 * Usage:
 *   node scripts/reference-fixture-publisher.cjs \
 *     --storyboard static/compliance/source/specialisms/buyer-discovery/index.yaml \
 *     --port 9100
 *
 * The server exposes JSON-RPC style endpoints at POST /tool/{tool_name}.
 * A buyer agent or storyboard runner connects and calls tools like
 * get_adcp_capabilities, get_products, create_media_buy, etc.
 *
 * This is a REFERENCE implementation — production runners should
 * implement the buyer-fixture-publisher.yaml contract directly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('js-yaml not found. Run: npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
const storyboardIndex = args.indexOf('--storyboard');
const portIndex = args.indexOf('--port');

if (storyboardIndex === -1) {
  console.error('Usage: node reference-fixture-publisher.cjs --storyboard <path> [--port <port>]');
  process.exit(1);
}

const storyboardPath = args[storyboardIndex + 1];
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 9100;

const storyboard = yaml.load(fs.readFileSync(storyboardPath, 'utf8'));

if (!storyboard.fixtures?.fixture_publisher) {
  console.error('Storyboard has no fixtures.fixture_publisher block');
  process.exit(1);
}

const fixture = storyboard.fixtures.fixture_publisher;
const capabilities = fixture.capabilities ?? {};
const products = fixture.products ?? [];
const scenarios = fixture.scenarios ?? {};

// State
const idempotencyCache = new Map();
const asyncTasks = new Map();
const mediaBuys = new Map();
let callLog = [];

function writeJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Tool handlers

function handleGetAdcpCapabilities() {
  return {
    adcp: capabilities.adcp ?? { supported_versions: ['3.1'] },
    supported_protocols: capabilities.supported_protocols ?? ['media_buy'],
    media_buy: capabilities.media_buy ?? {},
    specialisms: capabilities.specialisms ?? [],
  };
}

function handleGetProducts(body) {
  const cid = body.context?.correlation_id ?? '';
  if (scenarios.seller_offline && cid.includes('unavailable')) {
    return { _status: 503, error: { code: 'SERVICE_UNAVAILABLE', message: 'Seller offline' } };
  }
  return {
    products: products.map(p => ({
      product_id: p.product_id,
      name: p.name ?? p.product_id,
      delivery_type: p.delivery_type,
      channels: p.channels ?? [],
      pricing_options: p.pricing_options ?? [],
      format_options: p.format_options ?? [],
      audience_activation: p.audience_activation ?? undefined,
    })),
  };
}

function handleListProducts(body) {
  return handleGetProducts(body);
}

function handleCreateMediaBuy(body) {
  const key = body.idempotency_key;
  if (!key) {
    return {
      _status: 400,
      error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotency_key is required' },
    };
  }

  // Idempotency check
  if (idempotencyCache.has(key)) {
    const cached = idempotencyCache.get(key);
    return cached;
  }

  // Scenario selection based on correlation_id hints from the storyboard
  const cid = body.context?.correlation_id ?? '';

  if (scenarios.auth_expiry && cid.includes('auth_expired')) {
    return {
      _status: scenarios.auth_expiry.http_status ?? 401,
      error: { code: scenarios.auth_expiry.error_code ?? 'UNAUTHORIZED', message: 'Token expired' },
    };
  }

  if (scenarios.idempotency_conflict && cid.includes('conflict')) {
    return {
      _status: scenarios.idempotency_conflict.http_status ?? 409,
      error: { code: 'IDEMPOTENCY_CONFLICT', message: scenarios.idempotency_conflict.message ?? 'Key reused with different payload' },
    };
  }

  if (scenarios.rate_limited && cid.includes('rate_limited')) {
    return {
      _status: scenarios.rate_limited.http_status ?? 429,
      error: { code: 'RATE_LIMITED', message: 'Too many requests', retry_after: scenarios.rate_limited.retry_after ?? 10 },
    };
  }

  if (scenarios.seller_offline && cid.includes('unavailable')) {
    return {
      _status: scenarios.seller_offline.http_status ?? 503,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Seller offline' },
    };
  }

  if (scenarios.create_transient_failure && cid.includes('fails')) {
    const errorResponse = {
      _status: 503,
      error: {
        code: scenarios.create_transient_failure.error_code ?? 'TEMPORARILY_UNAVAILABLE',
        message: 'Service temporarily unavailable',
        retry_after: scenarios.create_transient_failure.retry_after ?? 5,
      },
    };
    // Error responses are NOT cached per AdCP idempotency rule 3
    return errorResponse;
  }

  // Check for async scenario
  if (scenarios.create_async &&
      body.context?.correlation_id?.includes('async')) {
    const taskId = scenarios.create_async.task_id ?? `task_${crypto.randomUUID()}`;
    const response = {
      status: 'submitted',
      task_id: taskId,
      media_buy_status: 'submitted',
    };
    asyncTasks.set(taskId, {
      status: 'completed',
      media_buy_id: `mb_${crypto.randomUUID().slice(0, 8)}`,
      media_buy_status: 'pending_creatives',
    });
    idempotencyCache.set(key, response);
    return response;
  }

  // Default: synchronous success
  const mediaBuyId = `mb_${crypto.randomUUID().slice(0, 8)}`;
  const mbStatus = scenarios.create_success?.media_buy_status ?? 'pending_creatives';
  const response = {
    media_buy_id: mediaBuyId,
    media_buy_status: mbStatus,
    status: 'completed',
    packages: (body.packages ?? []).map((pkg, i) => ({
      package_id: `pkg_${i}`,
      product_id: pkg.product_id,
      pricing_option_id: pkg.pricing_option_id,
      budget: pkg.budget,
    })),
  };
  mediaBuys.set(mediaBuyId, response);
  idempotencyCache.set(key, response);
  return response;
}

function handleGetTaskStatus(body) {
  const taskId = body.task_id;
  if (!taskId) {
    return {
      _status: 400,
      error: { code: 'MISSING_TASK_ID', message: 'task_id is required' },
    };
  }
  const task = asyncTasks.get(taskId);
  if (!task) {
    return {
      _status: 404,
      error: { code: 'TASK_NOT_FOUND', message: `Unknown task: ${taskId}` },
    };
  }
  return {
    task_id: taskId,
    status: task.status,
    media_buy_id: task.media_buy_id,
    media_buy_status: task.media_buy_status,
  };
}

function handleSyncCreatives(body) {
  const key = body.idempotency_key;
  if (!key) {
    return {
      _status: 400,
      error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotency_key is required' },
    };
  }

  if (idempotencyCache.has(key)) {
    return idempotencyCache.get(key);
  }

  const response = {
    media_buy_id: body.media_buy_id,
    creatives: (body.creatives ?? []).map(c => ({
      creative_id: c.creative_id,
      package_ids: c.package_ids ?? [],
      status: 'assigned',
    })),
    media_buy_status: 'active',
  };
  idempotencyCache.set(key, response);
  return response;
}

// Proposal state
const proposals = new Map();
let proposalCounter = 0;

function handleRequestProposals(body) {
  const key = body.idempotency_key;
  if (!key) return { _status: 400, error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotency_key is required' } };
  if (idempotencyCache.has(key)) return idempotencyCache.get(key);

  proposalCounter++;
  const proposalId = scenarios.proposal_returned?.proposal_id ?? `prop_${String(proposalCounter).padStart(3, '0')}`;
  const response = {
    proposal_id: proposalId,
    products: body.products ?? [],
    commercial_terms: scenarios.proposal_returned?.commercial_terms ?? {
      change_terms: [{ change_term_id: 'ct_cancel', mode: 'negotiated_cancellation' }],
    },
    status: 'proposed',
  };
  proposals.set(proposalId, response);
  idempotencyCache.set(key, response);
  return response;
}

function handleRefineProposals(body) {
  const key = body.idempotency_key;
  if (!key) return { _status: 400, error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotency_key is required' } };
  if (idempotencyCache.has(key)) return idempotencyCache.get(key);

  if (scenarios.terms_rejected && body.context?.correlation_id?.includes('rejected')) {
    return {
      _status: 422,
      error: {
        code: scenarios.terms_rejected.error_code ?? 'TERMS_REJECTED',
        message: scenarios.terms_rejected.reason ?? 'Terms rejected',
        rejected_terms: scenarios.terms_rejected.rejected_terms ?? [],
      },
    };
  }

  proposalCounter++;
  const proposalId = scenarios.proposal_refined?.proposal_id ?? `prop_${String(proposalCounter).padStart(3, '0')}`;
  const response = {
    proposal_id: proposalId,
    status: 'revised',
    revised_rate: scenarios.proposal_refined?.revised_rate,
  };
  proposals.set(proposalId, response);
  idempotencyCache.set(key, response);
  return response;
}

function handleDeclineProposals(body) {
  const key = body.idempotency_key;
  if (!key) return { _status: 400, error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotency_key is required' } };
  if (idempotencyCache.has(key)) return idempotencyCache.get(key);
  const response = { proposal_id: body.proposal_id, status: 'declined' };
  idempotencyCache.set(key, response);
  return response;
}

function handleAcceptProposal(body) {
  const key = body.idempotency_key;
  if (!key) return { _status: 400, error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotency_key is required' } };
  if (idempotencyCache.has(key)) return idempotencyCache.get(key);

  const mediaBuyId = `mb_${crypto.randomUUID().slice(0, 8)}`;
  const response = {
    proposal_id: body.proposal_id,
    media_buy_id: mediaBuyId,
    media_buy_status: 'pending_creatives',
    status: 'accepted',
  };
  mediaBuys.set(mediaBuyId, response);
  idempotencyCache.set(key, response);
  return response;
}

function handleControlMediaBuy(body) {
  const key = body.idempotency_key;
  if (!key) return { _status: 400, error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotency_key is required' } };
  if (idempotencyCache.has(key)) return idempotencyCache.get(key);

  const response = {
    media_buy_id: body.media_buy_id,
    action: body.action,
    media_buy_status: body.action === 'pause' ? 'paused' : 'active',
  };
  idempotencyCache.set(key, response);
  return response;
}

function handleGetMediaBuys(body) {
  const activeBuy = fixture.active_buy;
  if (activeBuy) {
    return { media_buys: [activeBuy] };
  }
  return { media_buys: [...mediaBuys.values()] };
}

function handleGetMediaBuyDelivery(body) {
  const normal = scenarios.normal_delivery ?? {};
  const under = scenarios.under_delivery ?? {};
  const isUnderDelivery = body.context?.correlation_id?.includes('under_delivery');
  const data = isUnderDelivery ? under : normal;
  return {
    media_buy_id: body.media_buy_id ?? fixture.active_buy?.media_buy_id ?? 'unknown',
    impressions: data.impressions ?? 0,
    spend: data.spend ?? 0,
    pacing_percentage: data.pacing_percentage ?? 0,
    flight_elapsed_percentage: data.flight_elapsed_percentage ?? 0,
  };
}

const TOOL_HANDLERS = {
  get_adcp_capabilities: handleGetAdcpCapabilities,
  get_products: handleGetProducts,
  list_products: handleListProducts,
  create_media_buy: handleCreateMediaBuy,
  get_task_status: handleGetTaskStatus,
  sync_creatives: handleSyncCreatives,
  request_proposals: handleRequestProposals,
  refine_proposals: handleRefineProposals,
  decline_proposals: handleDeclineProposals,
  accept_proposal: handleAcceptProposal,
  control_media_buy: handleControlMediaBuy,
  get_media_buys: handleGetMediaBuys,
  get_media_buy_delivery: handleGetMediaBuyDelivery,
};

// HTTP server

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, { status: 'ok', storyboard: storyboard.id });
      return;
    }

    // Call log (for runner inspection)
    if (req.method === 'GET' && url.pathname === '/_calls') {
      writeJson(res, 200, { calls: callLog });
      return;
    }

    // Reset state
    if (req.method === 'POST' && url.pathname === '/_reset') {
      idempotencyCache.clear();
      asyncTasks.clear();
      mediaBuys.clear();
      proposals.clear();
      proposalCounter = 0;
      callLog = [];
      writeJson(res, 200, { status: 'reset' });
      return;
    }

    // Tool dispatch: POST /tool/{tool_name}
    if (req.method === 'POST' && url.pathname.startsWith('/tool/')) {
      const toolName = url.pathname.slice(6);
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        writeJson(res, 404, { error: { code: 'UNKNOWN_TOOL', message: `No handler for ${toolName}` } });
        return;
      }

      const body = await readBody(req);
      const timestamp = new Date().toISOString();
      callLog.push({ tool: toolName, request: body, timestamp });

      const result = handler(body);
      const status = result._status ?? 200;
      delete result._status;

      callLog[callLog.length - 1].response = result;
      callLog[callLog.length - 1].status = status;

      writeJson(res, status, result);
      return;
    }

    writeJson(res, 404, { error: { code: 'NOT_FOUND', message: `Unknown path: ${url.pathname}` } });
  } catch (err) {
    writeJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: err?.message ?? 'unexpected error' } });
  }
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`Fixture publisher for "${storyboard.id}" listening on http://127.0.0.1:${boundPort}`);
  console.log(`  Products: ${products.map(p => p.product_id).join(', ') || '(none)'}`);
  console.log(`  Scenarios: ${Object.keys(scenarios).join(', ') || '(none)'}`);
  console.log(`  Tools: ${Object.keys(TOOL_HANDLERS).join(', ')}`);
  console.log(`  Health: GET /health`);
  console.log(`  Call log: GET /_calls`);
  console.log(`  Reset: POST /_reset`);
});
