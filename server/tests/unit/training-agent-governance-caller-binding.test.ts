import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Initialize the aggregate tool catalog before importing leaf handlers. The
// production entrypoint uses the same order for this intentional module cycle.
import '../../src/training-agent/task-handlers.js';
import {
  handleCheckGovernance,
  handleGetPlanAuditLogs,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DELEGATED_AGENT = 'https://delegated.example';
const ATTACKER_AGENT = 'https://attacker.example';
const BRAND = { domain: 'caller-binding.example' };
const BASE_PLAN = {
  plan_id: 'plan-caller-binding',
  brand: BRAND,
  objectives: 'Verify caller authorization uses authenticated agent identity.',
  budget: { total: 100_000, currency: 'USD', reallocation_threshold: 100_000 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
};

const OPEN_CTX: TrainingContext = { mode: 'open' };
const DELEGATED_CTX: TrainingContext = {
  mode: 'open',
  authenticatedAgentUrl: DELEGATED_AGENT,
};
const ATTACKER_CTX: TrainingContext = {
  mode: 'open',
  authenticatedAgentUrl: ATTACKER_AGENT,
};

async function syncPlan(plan: Record<string, unknown>, ctx: TrainingContext = OPEN_CTX) {
  const result = await handleSyncPlans({ plans: [plan] }, ctx) as Record<string, any>;
  expect(result.errors, JSON.stringify(result)).toBeUndefined();
}

async function check(caller: string, ctx: TrainingContext) {
  return handleCheckGovernance({
    plan_id: BASE_PLAN.plan_id,
    caller,
    tool: 'create_media_buy',
    payload: {
      target_seller: 'https://seller.example',
      total_budget: { amount: 10_000, currency: 'USD' },
      geo: { countries: ['US'] },
    },
  }, ctx) as Promise<Record<string, any>>;
}

async function audit(ctx: TrainingContext = OPEN_CTX) {
  return handleGetPlanAuditLogs({
    brand: BRAND,
    plan_ids: [BASE_PLAN.plan_id],
    include_entries: true,
  }, ctx) as Promise<Record<string, any>>;
}

function expectIdentityError(result: Record<string, any>) {
  expect(result).toEqual({
    errors: [{
      code: 'PERMISSION_DENIED',
      message: 'Authenticated agent identity is required and must match caller for this governance check.',
    }],
  });
}

function expectNoCheckRecorded(result: Record<string, any>) {
  expect(result.plans[0].summary.checks_performed).toBe(0);
  expect(result.plans[0].entries).toEqual([]);
}

describe('check_governance authenticated caller binding', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('uses a matching authenticated delegation identity in the JWS and audit log', async () => {
    await runWithSessionContext(async () => {
      await syncPlan({
        ...BASE_PLAN,
        delegations: [{
          agent_url: DELEGATED_AGENT,
          authority: 'full',
          budget_limit: { amount: 25_000, currency: 'USD' },
          markets: ['US'],
        }],
      });

      const result = await check(DELEGATED_AGENT, DELEGATED_CTX);
      const auditResult = await audit();

      expect(result.status).toBe('approved');
      expect(decodeJwt(result.governance_context).caller).toBe(DELEGATED_AGENT);
      expect(auditResult.plans[0].summary.checks_performed).toBe(1);
      expect(auditResult.plans[0].entries[0]).toMatchObject({
        type: 'check',
        caller: DELEGATED_AGENT,
      });
    });
  });

  it('rejects a privileged caller claim from a different authenticated agent before side effects', async () => {
    await runWithSessionContext(async () => {
      await syncPlan({
        ...BASE_PLAN,
        mode: 'audit',
        human_review_required: true,
        delegations: [{ agent_url: DELEGATED_AGENT, authority: 'full' }],
      });

      expectIdentityError(await check(DELEGATED_AGENT, ATTACKER_CTX));
      expectNoCheckRecorded(await audit());
    });
  });

  it('rejects a restricted plan when no authenticated agent URL is available', async () => {
    await runWithSessionContext(async () => {
      await syncPlan({
        ...BASE_PLAN,
        delegations: [{ agent_url: DELEGATED_AGENT, authority: 'full' }],
      });

      expectIdentityError(await check(DELEGATED_AGENT, OPEN_CTX));
      expectNoCheckRecorded(await audit());
    });
  });

  it('rejects an approved-seller spoof before side effects', async () => {
    await runWithSessionContext(async () => {
      await syncPlan({ ...BASE_PLAN, approved_sellers: [DELEGATED_AGENT] });

      expectIdentityError(await check(DELEGATED_AGENT, ATTACKER_CTX));
      expectNoCheckRecorded(await audit());
    });
  });

  it('accepts a matching authenticated approved seller', async () => {
    await runWithSessionContext(async () => {
      await syncPlan({ ...BASE_PLAN, approved_sellers: [DELEGATED_AGENT] });

      expect((await check(DELEGATED_AGENT, DELEGATED_CTX)).status).toBe('approved');
    });
  });

  it('keeps unrestricted legacy checks compatible when no agent URL mapping exists', async () => {
    await runWithSessionContext(async () => {
      await syncPlan(BASE_PLAN);

      const result = await check(DELEGATED_AGENT, OPEN_CTX);
      expect(result.status).toBe('approved');
      expect(decodeJwt(result.governance_context).caller).toBe(DELEGATED_AGENT);
    });
  });
});
