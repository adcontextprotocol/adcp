/**
 * adcp#7758: a third-party seller registered with the public sandbox
 * governance agent must be able to run its execution check.
 *
 * Reproduces the blockers against the governance tenant over HTTP, then
 * proves the fix:
 * - the storyboards' placeholder credential and the shared public token
 *   cannot authenticate as the seller (B1, B2);
 * - a minted governance-agent credential authenticates as exactly the
 *   bound seller, only on the governance tenant, only for the seller side
 *   of the loop, only on its own run's plans;
 * - the governance agent is coherent under one URL: tokens carry
 *   `iss` = the training agent URL the storyboards register, that URL
 *   serves MCP, and the revocation list names the same issuer (B3).
 */
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const PUBLIC_TOKEN = 'test-token-governance-agent-credentials';

// Generated per run so no key material lives in the repository.
const { CREDENTIAL_SECRET } = vi.hoisted(() => {
  const secret = require('node:crypto').randomBytes(32).toString('hex') as string;
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-governance-agent-credentials';
  process.env.TRAINING_GOVERNANCE_CREDENTIAL_SECRET = secret;
  return { CREDENTIAL_SECRET: secret };
});

import {
  GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS,
  mintGovernanceAgentCredential,
  verifyGovernanceAgentCredential,
} from '../../src/training-agent/governance-agent-credentials.js';
import { getTrainingGovernanceIssuer } from '../../src/training-agent/canonical-base.js';
import { clearSessions, stopSessionCleanup } from '../../src/training-agent/state.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';

const SELLER = 'https://seller.gov-7758.example/mcp';
const OTHER_SELLER = 'https://other-seller.gov-7758.example/mcp';
const PLACEHOLDER = 'gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PUBLIC_IDENTITY = `https://training-agent.adcontextprotocol.org/authenticated/${createHash('sha256').update(PUBLIC_TOKEN).digest('hex').slice(0, 32)}`;

let origin = '';
let base = '';
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
  const srv = http.createServer(app);
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  base = `${origin}/api/training-agent`;
  // Local runs pin the canonical base (and so the governance identity) to
  // the local mount, as the storyboard matrix does for multi-agent runs.
  process.env.TRAINING_AGENT_URL = base;
  close = () => new Promise(resolve => srv.close(() => resolve()));
});

afterAll(async () => {
  delete process.env.TRAINING_AGENT_URL;
  stopSessionCleanup();
  await close();
});

afterEach(() => {
  clearSessions();
  clearAccountStore();
});

let rpcId = 0;
async function rpc(url: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, ...body }),
  });
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

async function callTool(url: string, token: string, name: string, args: Record<string, unknown>) {
  const { status, json } = await rpc(url, token, { method: 'tools/call', params: { name, arguments: args } });
  const result = json?.result as { structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
  const structured = result?.structuredContent ?? {};
  const error = (structured.adcp_error ?? (Array.isArray(structured.errors) ? structured.errors[0] : undefined)) as
    | { code?: string; message?: string }
    | undefined;
  return { status, json, structured, error };
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

const governanceMcp = () => `${base}/governance/mcp`;

async function approvedIntent(planId: string, target = SELLER): Promise<string> {
  const sync = await callTool(governanceMcp(), PUBLIC_TOKEN, 'sync_plans', {
    idempotency_key: randomUUID(),
    plans: [{
      plan_id: planId,
      brand: { domain: 'acmeoutdoor.example' },
      objectives: 'adcp#7758 third-party seller execution check',
      budget: { total: 100000, currency: 'USD', reallocation_threshold: 100000 },
      flight: { start: '2020-01-01T00:00:00Z', end: '2099-06-30T23:59:59Z' },
      countries: ['US'],
    }],
  });
  expect(sync.error, JSON.stringify(sync.json)).toBeUndefined();
  const intent = await callTool(governanceMcp(), PUBLIC_TOKEN, 'check_governance', {
    plan_id: planId,
    caller: PUBLIC_IDENTITY,
    target_agent: target,
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    proposed_commitment: { amount: 1000, currency: 'USD' },
    payload: {
      brand: { domain: 'acmeoutdoor.example' },
      account: { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example' },
      total_budget: { amount: 1000, currency: 'USD' },
      start_time: 'asap',
      end_time: '2099-06-30T23:59:59Z',
      packages: [],
      idempotency_key: randomUUID(),
    },
  });
  expect(intent.structured.status ?? intent.structured.verdict, JSON.stringify(intent.json)).toBe('approved');
  return intent.structured.governance_context as string;
}

function executionCheck(governanceContext: string, caller = SELLER) {
  return {
    caller,
    governance_context: governanceContext,
    phase: 'purchase',
    planned_delivery: {
      total_budget: 1000,
      currency: 'USD',
      channels: ['display'],
      geo: { countries: ['US'] },
      start_time: new Date().toISOString(),
      end_time: '2099-06-30T23:59:59Z',
    },
  };
}

describe('governance agent credentials (adcp#7758)', () => {
  it('reproduces B1/B2: neither the storyboard placeholder nor the public token can authenticate as the seller', async () => {
    const nonce = randomUUID();
    const context = await approvedIntent(`plan-7758-${nonce}`);

    const placeholder = await callTool(governanceMcp(), PLACEHOLDER, 'check_governance', executionCheck(context));
    expect(placeholder.status).toBe(401);

    const publicAsSeller = await callTool(governanceMcp(), PUBLIC_TOKEN, 'check_governance', executionCheck(context));
    expect(publicAsSeller.error?.code).toBe('PERMISSION_DENIED');
    expect(publicAsSeller.error?.message).toContain('must match caller');

    const publicAsItself = await callTool(governanceMcp(), PUBLIC_TOKEN, 'check_governance', executionCheck(context, PUBLIC_IDENTITY));
    expect(publicAsItself.error?.code).toBe('PERMISSION_DENIED');
    expect(publicAsItself.error?.message).toContain('service audience');
  });

  it('lets a minted credential run the seller execution check at the registered governance URL', async () => {
    const nonce = randomUUID();
    const context = await approvedIntent(`plan-7758-${nonce}`);
    const credential = mintGovernanceAgentCredential(SELLER, { nonce });

    // The registered governance URL is the training agent URL itself.
    const registeredUrl = getTrainingGovernanceIssuer();
    expect(registeredUrl).toBe(base);
    const approved = await callTool(registeredUrl, credential, 'check_governance', executionCheck(context));
    expect(approved.error, JSON.stringify(approved.json)).toBeUndefined();
    expect(approved.structured.status ?? approved.structured.verdict).toBe('approved');
    expect(approved.structured.check_type).toBe('execution');
    const purchase = claimsOf(approved.structured.governance_context as string);
    expect(purchase).toMatchObject({ iss: registeredUrl, aud: SELLER, caller: SELLER, phase: 'purchase' });

    // The same credential works on the tenant path too.
    const again = await callTool(governanceMcp(), credential, 'get_adcp_capabilities', {});
    expect(again.status).toBe(200);
  });

  it('keeps B3 coherent: intent tokens and the revocation list name the registered governance URL', async () => {
    const context = await approvedIntent(`plan-7758-${randomUUID()}`);
    const iss = claimsOf(context).iss;
    expect(iss).toBe(getTrainingGovernanceIssuer());
    expect(iss).toBe(base);
    expect(String(iss).endsWith('/')).toBe(false);

    const response = await fetch(`${base}/.well-known/governance-revocations.json`);
    const signed = await response.json() as { payload: string };
    const list = JSON.parse(Buffer.from(signed.payload, 'base64url').toString('utf8')) as { issuer: string };
    expect(list.issuer).toBe(iss);
  });

  it('binds the credential to exactly one seller URL', async () => {
    const nonce = randomUUID();
    const context = await approvedIntent(`plan-7758-${nonce}`);
    const otherSellerCredential = mintGovernanceAgentCredential(OTHER_SELLER, { nonce });

    const claimsSeller = await callTool(governanceMcp(), otherSellerCredential, 'check_governance', executionCheck(context, SELLER));
    expect(claimsSeller.error?.code).toBe('PERMISSION_DENIED');

    const asItself = await callTool(governanceMcp(), otherSellerCredential, 'check_governance', executionCheck(context, OTHER_SELLER));
    expect(asItself.error?.code).toBe('PERMISSION_DENIED');
    expect(asItself.error?.message).toContain('service audience');
  });

  it('scopes the credential to the plans of its own hosted run', async () => {
    const otherRunContext = await approvedIntent(`plan-7758-${randomUUID()}`);
    const credential = mintGovernanceAgentCredential(SELLER, { nonce: randomUUID() });
    const outOfScope = await callTool(governanceMcp(), credential, 'check_governance', executionCheck(otherRunContext));
    expect(outOfScope.error?.code).toBe('PERMISSION_DENIED');
    expect(outOfScope.error?.message).toContain('hosted run');
  });

  it('limits the credential to the seller side of the governance loop', async () => {
    const nonce = randomUUID();
    const credential = mintGovernanceAgentCredential(SELLER, { nonce });

    const syncPlans = await callTool(governanceMcp(), credential, 'sync_plans', {
      idempotency_key: randomUUID(),
      plans: [{ plan_id: `plan-7758-${nonce}`, brand: { domain: 'acmeoutdoor.example' }, objectives: 'x', budget: { total: 1, currency: 'USD' } }],
    });
    expect(syncPlans.status).toBe(403);
    for (const tool of ['report_plan_outcome', 'get_plan_audit_logs', 'comply_test_controller', 'list_accounts', 'sync_accounts']) {
      const denied = await callTool(governanceMcp(), credential, tool, {});
      expect(denied.status, tool).toBe(403);
    }

    const intent = await callTool(governanceMcp(), credential, 'check_governance', {
      plan_id: `plan-7758-${nonce}`,
      caller: SELLER,
      target_agent: SELLER,
      tool: 'create_media_buy',
      payload: { idempotency_key: randomUUID() },
    });
    expect(intent.error?.code).toBe('PERMISSION_DENIED');
  });

  it('authenticates only on the governance tenant', async () => {
    const credential = mintGovernanceAgentCredential(SELLER, { nonce: randomUUID() });
    for (const url of [`${base}/sales/mcp`, `${base}/signals/mcp`, `${base}/mcp`]) {
      const response = await rpc(url, credential, { method: 'tools/list' });
      expect(response.status, url).toBe(401);
    }
  });

  it('rejects tampered, expired, and unconfigured credentials', async () => {
    const nonce = randomUUID();
    const credential = mintGovernanceAgentCredential(SELLER, { nonce });
    expect(verifyGovernanceAgentCredential(credential)).toMatchObject({ agentUrl: SELLER, nonce });

    const [prefix, payload, mac] = [credential.slice(0, 20), ...credential.slice(20).split('.')];
    const forgedPayload = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      agent_url: OTHER_SELLER,
    })).toString('base64url');
    expect(verifyGovernanceAgentCredential(`${prefix}${forgedPayload}.${mac}`)).toBeNull();
    const tampered = await rpc(governanceMcp(), `${prefix}${forgedPayload}.${mac}`, { method: 'tools/list' });
    expect(tampered.status).toBe(401);

    const past = Math.floor(Date.now() / 1000) - GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS - 5;
    const expired = mintGovernanceAgentCredential(SELLER, { nonce, now: past });
    expect(verifyGovernanceAgentCredential(expired)).toBeNull();
    expect((await rpc(governanceMcp(), expired, { method: 'tools/list' })).status).toBe(401);

    vi.stubEnv('TRAINING_GOVERNANCE_CREDENTIAL_SECRET', '');
    try {
      expect(verifyGovernanceAgentCredential(credential)).toBeNull();
      expect(() => mintGovernanceAgentCredential(SELLER, { nonce })).toThrow(/not configured/);
    } finally {
      vi.stubEnv('TRAINING_GOVERNANCE_CREDENTIAL_SECRET', CREDENTIAL_SECRET);
    }
  });

  it('refuses to mint for identities the seller must not assume', () => {
    const nonce = randomUUID();
    for (const url of [
      'http://seller.example/mcp',
      'https://test-agent.adcontextprotocol.org/sales',
      'https://agenticadvertising.org/sales',
      'https://training-agent.adcontextprotocol.org/authenticated/abc',
      'https://user:pass@seller.example/mcp',
      'https://seller.example/mcp?x=1',
      'not a url',
    ]) {
      expect(() => mintGovernanceAgentCredential(url, { nonce }), url).toThrow();
    }
    expect(() => mintGovernanceAgentCredential(SELLER, { nonce: 'short' })).toThrow();
    expect(() => mintGovernanceAgentCredential('http://127.0.0.1:1234/mcp', { nonce })).toThrow();
    expect(mintGovernanceAgentCredential('http://127.0.0.1:1234/mcp', { nonce, allowLoopbackHttp: true }))
      .toMatch(/^adcp-sandbox-gov\.v1\./);

    const capped = mintGovernanceAgentCredential(SELLER, { nonce, ttlSeconds: 24 * 3600 });
    const claims = verifyGovernanceAgentCredential(capped)!;
    expect(claims.exp - claims.iat).toBe(GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS);
  });
});
