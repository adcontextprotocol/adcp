/**
 * adcp#7758 (decision B4): hosted grading authenticates to the sandbox
 * governance agent as one fixed buyer agent, so the intent token `caller` is
 * an identity a third-party seller can map its grading credential to.
 *
 * Proves over HTTP against the governance tenant that a minted hosted-grader
 * credential:
 * - authenticates as exactly HOSTED_GRADER_BUYER_AGENT_URL, which becomes the
 *   intent `caller`, and lets the per-run seller credential run the seller's
 *   execution check on the same plan;
 * - is limited to the buyer side of its own run (plan setup, intent checks,
 *   audit reads, outcome reports on nonce-suffixed plans);
 * - never verifies as a seller credential, or the reverse;
 * - authenticates only on the governance tenant.
 *
 * Also covers the hosted-grader brand host (decision D): the brand.json it
 * serves validates against the brand.json schema, lists the governance agent
 * under the token `iss`, and points at a governance-only JWKS on its own
 * origin.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-hosted-grader-credential';
  process.env.TRAINING_GOVERNANCE_CREDENTIAL_SECRET = require('node:crypto').randomBytes(32).toString('hex') as string;
});

import {
  GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS,
  mintGovernanceAgentCredential,
  mintHostedGraderCredential,
  verifyGovernanceAgentCredential,
  verifyHostedGraderCredential,
} from '../../src/training-agent/governance-agent-credentials.js';
import { getTrainingGovernanceIssuer } from '../../src/training-agent/canonical-base.js';
import { getGovernanceSigningPublicJwk } from '../../src/training-agent/governance-signing.js';
import {
  HOSTED_GRADER_BRAND_DOMAIN,
  HOSTED_GRADER_BUYER_AGENT_URL,
  HOSTED_GRADER_ORIGIN,
  createHostedGraderHostRouter,
  hostedGraderBrandJson,
} from '../../src/training-agent/hosted-grader.js';
import { clearSessions, stopSessionCleanup } from '../../src/training-agent/state.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';

const SELLER = 'https://seller.hosted-grader-7758.example/mcp';

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
  await new Promise<void>(done => srv.listen(0, '127.0.0.1', () => done()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/training-agent`;
  process.env.TRAINING_AGENT_URL = base;
  close = () => new Promise(done => srv.close(() => done()));
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
  const result = json?.result as { structuredContent?: Record<string, unknown> } | undefined;
  const structured = result?.structuredContent ?? {};
  const error = (structured.adcp_error ?? (Array.isArray(structured.errors) ? structured.errors[0] : undefined)) as
    | { code?: string; message?: string }
    | undefined;
  return { status, json, structured, error };
}

const governanceMcp = () => `${base}/governance/mcp`;

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

function plan(planId: string) {
  return {
    plan_id: planId,
    brand: { domain: HOSTED_GRADER_BRAND_DOMAIN },
    objectives: 'adcp#7758 hosted-grader buyer identity',
    budget: { total: 100000, currency: 'USD', reallocation_threshold: 100000 },
    flight: { start: '2020-01-01T00:00:00Z', end: '2099-06-30T23:59:59Z' },
    countries: ['US'],
  };
}

function intentCheck(planId: string, caller = HOSTED_GRADER_BUYER_AGENT_URL) {
  return {
    plan_id: planId,
    caller,
    target_agent: SELLER,
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    proposed_commitment: { amount: 1000, currency: 'USD' },
    payload: {
      brand: { domain: HOSTED_GRADER_BRAND_DOMAIN },
      account: { brand: { domain: HOSTED_GRADER_BRAND_DOMAIN }, operator: 'pinnacle-agency.example' },
      total_budget: { amount: 1000, currency: 'USD' },
      start_time: 'asap',
      end_time: '2099-06-30T23:59:59Z',
      packages: [],
      idempotency_key: randomUUID(),
    },
  };
}

describe('hosted-grader governance credential (adcp#7758)', () => {
  it('authenticates as the fixed hosted-grader buyer agent, which becomes the intent caller the seller checks', async () => {
    const nonce = randomUUID();
    const grader = mintHostedGraderCredential({ nonce });
    const planId = `comply-gov-approved-plan-${nonce}`;

    const sync = await callTool(governanceMcp(), grader, 'sync_plans', { idempotency_key: randomUUID(), plans: [plan(planId)] });
    expect(sync.error, JSON.stringify(sync.json)).toBeUndefined();

    const intent = await callTool(governanceMcp(), grader, 'check_governance', intentCheck(planId));
    expect(intent.structured.status ?? intent.structured.verdict, JSON.stringify(intent.json)).toBe('approved');
    const token = intent.structured.governance_context as string;
    expect(claimsOf(token)).toMatchObject({
      iss: getTrainingGovernanceIssuer(),
      aud: SELLER,
      caller: HOSTED_GRADER_BUYER_AGENT_URL,
      phase: 'intent',
    });

    // The seller's per-run credential runs its execution check on that plan.
    const seller = mintGovernanceAgentCredential(SELLER, { nonce });
    const execution = await callTool(governanceMcp(), seller, 'check_governance', {
      caller: SELLER,
      governance_context: token,
      phase: 'purchase',
      planned_delivery: {
        total_budget: 1000,
        currency: 'USD',
        start_time: new Date().toISOString(),
        end_time: '2099-06-30T23:59:59Z',
      },
    });
    expect(execution.structured.status ?? execution.structured.verdict, JSON.stringify(execution.json)).toBe('approved');

    // The buyer side closes the loop on its own plan.
    const audit = await callTool(governanceMcp(), grader, 'get_plan_audit_logs', { plan_ids: [planId] });
    expect(audit.error, JSON.stringify(audit.json)).toBeUndefined();
  });

  it('rejects a caller other than the hosted-grader buyer agent', async () => {
    const nonce = randomUUID();
    const grader = mintHostedGraderCredential({ nonce });
    const planId = `plan-${nonce}`;
    await callTool(governanceMcp(), grader, 'sync_plans', { idempotency_key: randomUUID(), plans: [plan(planId)] });
    const mismatch = await callTool(governanceMcp(), grader, 'check_governance', intentCheck(planId, 'https://pinnacle-agency.example'));
    expect(mismatch.error?.code).toBe('PERMISSION_DENIED');
    expect(mismatch.error?.message).toContain('must match caller');
  });

  it('scopes every plan it names to its own hosted run', async () => {
    const nonce = randomUUID();
    const grader = mintHostedGraderCredential({ nonce });
    const otherGrader = mintHostedGraderCredential({ nonce: randomUUID() });
    const planId = `plan-${nonce}`;
    await callTool(governanceMcp(), grader, 'sync_plans', { idempotency_key: randomUUID(), plans: [plan(planId)] });

    // Another run (same buyer agent URL, different nonce) cannot touch it.
    const crossRun = await callTool(governanceMcp(), otherGrader, 'check_governance', intentCheck(planId));
    expect(crossRun.error?.code).toBe('PERMISSION_DENIED');
    expect(crossRun.error?.message).toContain('hosted run');
    const crossAudit = await callTool(governanceMcp(), otherGrader, 'get_plan_audit_logs', { plan_ids: [planId] });
    expect(crossAudit.error?.code).toBe('PERMISSION_DENIED');
    const crossOutcome = await callTool(governanceMcp(), otherGrader, 'report_plan_outcome', {
      plan_id: planId,
      outcome: 'completed',
      idempotency_key: randomUUID(),
    });
    expect(crossOutcome.error?.code).toBe('PERMISSION_DENIED');

    // Plans without the nonce, or a mix, are refused on sync.
    const unscoped = await callTool(governanceMcp(), grader, 'sync_plans', {
      idempotency_key: randomUUID(),
      plans: [plan(`plan-${nonce}`), plan('someone-elses-plan')],
    });
    expect(unscoped.error?.code).toBe('PERMISSION_DENIED');

    // No portfolio or governance_context lookups.
    const portfolio = await callTool(governanceMcp(), grader, 'get_plan_audit_logs', { plan_ids: [planId], portfolio_plan_ids: ['x'] });
    expect(portfolio.error?.code).toBe('PERMISSION_DENIED');
  });

  it('is limited to the buyer side: no execution checks, adjustments, or other tools', async () => {
    const nonce = randomUUID();
    const grader = mintHostedGraderCredential({ nonce });
    const planId = `plan-${nonce}`;
    await callTool(governanceMcp(), grader, 'sync_plans', { idempotency_key: randomUUID(), plans: [plan(planId)] });
    const intent = await callTool(governanceMcp(), grader, 'check_governance', intentCheck(planId));
    const execution = await callTool(governanceMcp(), grader, 'check_governance', {
      caller: HOSTED_GRADER_BUYER_AGENT_URL,
      governance_context: intent.structured.governance_context,
      phase: 'purchase',
      planned_delivery: { total_budget: 1000, currency: 'USD' },
    });
    expect(execution.error?.code).toBe('PERMISSION_DENIED');

    for (const tool of ['report_plan_adjustment', 'comply_test_controller', 'list_accounts', 'sync_accounts', 'create_property_list']) {
      const denied = await callTool(governanceMcp(), grader, tool, {});
      expect(denied.status, tool).toBe(403);
    }
  });

  it('authenticates only on the governance tenant', async () => {
    const grader = mintHostedGraderCredential({ nonce: randomUUID() });
    for (const url of [`${base}/sales/mcp`, `${base}/signals/mcp`, `${base}/mcp`]) {
      const response = await rpc(url, grader, { method: 'tools/list' });
      expect(response.status, url).toBe(401);
    }
    expect((await rpc(governanceMcp(), grader, { method: 'tools/list' })).status).toBe(200);
  });

  it('never verifies as a seller credential, or the reverse, and rejects tampering and expiry', () => {
    const nonce = randomUUID();
    const grader = mintHostedGraderCredential({ nonce });
    const seller = mintGovernanceAgentCredential(SELLER, { nonce });
    expect(verifyHostedGraderCredential(grader)).toMatchObject({ agentUrl: HOSTED_GRADER_BUYER_AGENT_URL, nonce });
    expect(verifyGovernanceAgentCredential(grader)).toBeNull();
    expect(verifyHostedGraderCredential(seller)).toBeNull();

    // A seller credential's payload and MAC under the grader tag does not verify.
    const sellerBody = seller.slice('adcp-sandbox-gov.v1.'.length);
    expect(verifyHostedGraderCredential(`adcp-sandbox-gov-grader.v1.${sellerBody}`)).toBeNull();

    // Payload edits break the MAC.
    const [payload, mac] = grader.slice('adcp-sandbox-gov-grader.v1.'.length).split('.');
    const forged = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      agent_url: SELLER,
    })).toString('base64url');
    expect(verifyHostedGraderCredential(`adcp-sandbox-gov-grader.v1.${forged}.${mac}`)).toBeNull();

    const past = Math.floor(Date.now() / 1000) - GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS - 5;
    expect(verifyHostedGraderCredential(mintHostedGraderCredential({ nonce, now: past }))).toBeNull();
    const capped = verifyHostedGraderCredential(mintHostedGraderCredential({ nonce, ttlSeconds: 24 * 3600 }))!;
    expect(capped.exp - capped.iat).toBe(GOVERNANCE_AGENT_CREDENTIAL_MAX_TTL_SECONDS);
    expect(() => mintHostedGraderCredential({ nonce: 'short' })).toThrow();

    vi.stubEnv('TRAINING_GOVERNANCE_CREDENTIAL_SECRET', '');
    try {
      expect(verifyHostedGraderCredential(grader)).toBeNull();
      expect(() => mintHostedGraderCredential({ nonce })).toThrow(/not configured/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('hosted-grader brand host (adcp#7758)', () => {
  async function serveHost() {
    const app = express();
    app.use(createHostedGraderHostRouter());
    const srv = http.createServer(app);
    await new Promise<void>(done => srv.listen(0, '127.0.0.1', () => done()));
    const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    return { origin, close: () => new Promise<void>(done => srv.close(() => done())) };
  }

  it('publishes a schema-valid brand.json listing the governance agent under the token iss, and the grader buyer agent', async () => {
    const schemaRoot = resolve(__dirname, '../../../static/schemas/source');
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      loadSchema: async (uri: string) => {
        if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load: ${uri}`);
        return JSON.parse(readFileSync(resolve(schemaRoot, uri.replace('/schemas/', '')), 'utf8'));
      },
    });
    addFormats(ajv);
    const validate = await ajv.compileAsync(JSON.parse(readFileSync(resolve(schemaRoot, 'brand.json'), 'utf8')));
    // Production issuer: the loopback TRAINING_AGENT_URL this file sets for
    // its HTTP tests is not an https:// agent URL.
    const loopbackBase = process.env.TRAINING_AGENT_URL;
    delete process.env.TRAINING_AGENT_URL;
    let doc: Record<string, unknown>;
    try {
      doc = hostedGraderBrandJson();
      expect(getTrainingGovernanceIssuer()).toBe('https://test-agent.adcontextprotocol.org');
    } finally {
      process.env.TRAINING_AGENT_URL = loopbackBase;
    }
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);

    const agents = doc.agents as Array<{ type: string; url: string; jwks_uri?: string }>;
    const governance = agents.find(a => a.type === 'governance');
    expect(governance?.url).toBe('https://test-agent.adcontextprotocol.org');
    expect(governance?.jwks_uri).toBe(`${HOSTED_GRADER_ORIGIN}/.well-known/jwks.json`);
    expect(agents.find(a => a.type === 'buying')?.url).toBe(HOSTED_GRADER_BUYER_AGENT_URL);
    expect(new URL(HOSTED_GRADER_BUYER_AGENT_URL).hostname).toBe(HOSTED_GRADER_BRAND_DOMAIN);
  });

  it('serves only the brand.json and a governance-only JWKS', async () => {
    const host = await serveHost();
    try {
      const brand = await fetch(`${host.origin}/.well-known/brand.json`);
      expect(brand.status).toBe(200);
      expect(await brand.json()).toEqual(hostedGraderBrandJson());

      const jwks = await (await fetch(`${host.origin}/.well-known/jwks.json`)).json() as { keys: Array<Record<string, unknown>> };
      expect(jwks.keys).toEqual([getGovernanceSigningPublicJwk()]);
      expect(jwks.keys.every(k => k.adcp_use === 'governance-signing')).toBe(true);

      for (const path of ['/', '/buyer', '/schemas/latest/index.json', '/api/training-agent/mcp', '/.well-known/governance-revocations.json']) {
        expect((await fetch(`${host.origin}${path}`)).status, path).toBe(404);
      }
    } finally {
      await host.close();
    }
  });
});
