import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/training-agent/task-handlers.js';
import {
  handleCheckGovernance,
  handleGetPlanAuditLogs,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import { clearSessions, getSession, runWithSessionContext } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DELEGATE = 'https://delegated.example';
const ATTACKER = 'https://attacker.example';
const OWNER = 'https://owner.example';
const BRAND = { domain: 'caller-binding.example' };
const PLAN = {
  plan_id: 'plan-caller-binding',
  brand: BRAND,
  objectives: 'Bind governance authority to authenticated identity.',
  budget: { total: 100_000, currency: 'USD', reallocation_threshold: 100_000 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
};
const OPEN_CTX: TrainingContext = { mode: 'open' };
const OWNER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: OWNER };

async function sync(extra: Record<string, unknown> = {}) {
  return handleSyncPlans({ plans: [{ ...PLAN, ...extra }] }, OWNER_CTX) as Promise<Record<string, any>>;
}

async function check(caller: string, ctx: TrainingContext) {
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller,
    target_agent: 'https://seller.example',
    tool: 'create_media_buy',
    payload: {
      total_budget: { amount: 10_000, currency: 'USD' },
      geo: { countries: ['US'] },
    },
  }, ctx) as Promise<Record<string, any>>;
}

describe('check_governance authenticated caller binding', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('uses the matching authenticated URL in signed and audited state', async () => {
    await runWithSessionContext(async () => {
      await sync({ delegations: [{ agent_url: DELEGATE, authority: 'full', markets: ['US'] }] });
      const result = await check(DELEGATE, { mode: 'open', authenticatedAgentUrl: DELEGATE });
      const audit = await handleGetPlanAuditLogs({
        brand: BRAND,
        plan_ids: [PLAN.plan_id],
        include_entries: true,
      }, OWNER_CTX) as Record<string, any>;

      expect(result.verdict).toBe('approved');
      expect(decodeJwt(result.governance_context).caller).toBe(DELEGATE);
      expect(audit.plans[0].entries[0].caller).toBe(DELEGATE);
    });
  });

  it('rejects a privileged caller assertion from another authenticated agent before audit mutation', async () => {
    await runWithSessionContext(async () => {
      await sync({ delegations: [{ agent_url: DELEGATE, authority: 'full' }] });
      const result = await check(DELEGATE, { mode: 'open', authenticatedAgentUrl: ATTACKER });
      const audit = await handleGetPlanAuditLogs({
        brand: BRAND,
        plan_ids: [PLAN.plan_id],
        include_entries: true,
      }, OWNER_CTX) as Record<string, any>;

      expect(result.errors?.[0]?.code).toBe('PERMISSION_DENIED');
      expect(audit.plans[0].summary.checks_performed).toBe(0);
    });
  });

  it('fails closed for a restricted plan without a credential-to-agent mapping', async () => {
    await runWithSessionContext(async () => {
      await sync({ approved_sellers: ['https://seller.example'] });
      const result = await check(DELEGATE, OPEN_CTX);
      expect(result.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    });
  });

  it('never lets an unresolved caller assertion mint authorization', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const result = await check(DELEGATE, OPEN_CTX);
      expect(result.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    });
  });

  it('preserves the original delegated buyer across seller lifecycle checks', async () => {
    await runWithSessionContext(async () => {
      await sync({ delegations: [{ agent_url: DELEGATE, authority: 'full' }] });
      const intent = await check(DELEGATE, { mode: 'open', authenticatedAgentUrl: DELEGATE });
      const purchase = await handleCheckGovernance({
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { media_buy_id: 'mb_lifecycle', total_budget: 10_000, currency: 'USD' },
      }, { mode: 'open', authenticatedAgentUrl: 'https://seller.example' }) as Record<string, any>;
      const delivery = await handleCheckGovernance({
        caller: 'https://seller.example',
        governance_context: purchase.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_lifecycle', total_budget: 10_000, currency: 'USD' },
        delivery_metrics: { cumulative_spend: 1_000 },
      }, { mode: 'open', authenticatedAgentUrl: 'https://seller.example' }) as Record<string, any>;

      expect(purchase.verdict, JSON.stringify(purchase)).toBe('approved');
      expect(delivery.verdict, JSON.stringify(delivery)).toBe('approved');
    });
  });

  it('lets the authenticated owner act directly when the plan also has delegations', async () => {
    await runWithSessionContext(async () => {
      await sync({ delegations: [{ agent_url: DELEGATE, authority: 'full' }] });
      const intent = await check(OWNER, OWNER_CTX);
      const purchase = await handleCheckGovernance({
        caller: 'https://seller.example',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { media_buy_id: 'mb_owner_lifecycle', total_budget: 10_000, currency: 'USD' },
      }, { mode: 'open', authenticatedAgentUrl: 'https://seller.example' }) as Record<string, any>;

      expect(intent.verdict, JSON.stringify(intent)).toBe('approved');
      expect(purchase.verdict, JSON.stringify(purchase)).toBe('approved');
    });
  });

  it('rejects a same-owner re-sync that would move an existing plan to a fresh scope', async () => {
    await runWithSessionContext(async () => {
      expect((await sync()).errors).toBeUndefined();
      const originalSession = await getSession('open:caller-binding.example');
      const originalPlan = [...originalSession.governancePlans.values()].find(plan =>
        plan.planId === PLAN.plan_id && plan.ownerAgentUrl === OWNER)!;
      originalPlan.committedBudget = 25_000;

      const otherBrand = { domain: 'other-caller-binding.example' };
      const moved = await handleSyncPlans({
        plans: [{ ...PLAN, brand: otherBrand }],
      }, OWNER_CTX) as Record<string, any>;
      const otherSession = await getSession('open:other-caller-binding.example');

      expect(moved.errors?.[0]?.code).toBe('CONFLICT');
      expect(originalPlan.committedBudget).toBe(25_000);
      expect([...otherSession.governancePlans.values()].some(plan =>
        plan.planId === PLAN.plan_id && plan.ownerAgentUrl === OWNER)).toBe(false);
    });
  });

  it('namespaces the same opaque plan ID independently for another authenticated buyer', async () => {
    await runWithSessionContext(async () => {
      expect((await sync()).errors).toBeUndefined();

      const foreignCtx: TrainingContext = { mode: 'open', authenticatedAgentUrl: ATTACKER };
      const resync = await handleSyncPlans({ plans: [PLAN] }, foreignCtx) as Record<string, any>;
      const authorize = await check(ATTACKER, foreignCtx);
      const audit = await handleGetPlanAuditLogs({
        brand: BRAND,
        plan_ids: [PLAN.plan_id],
        include_entries: true,
      }, foreignCtx) as Record<string, any>;

      expect(resync).toMatchObject({ plans: [{ plan_id: PLAN.plan_id, version: 1 }] });
      expect(authorize.verdict, JSON.stringify(authorize)).toBe('approved');
      expect(authorize.governance_context).toEqual(expect.any(String));
      expect(audit.plans).toHaveLength(1);
      expect(audit.plans[0]).toMatchObject({ plan_id: PLAN.plan_id, plan_version: 1 });

      const sharedSession = await getSession('open:caller-binding.example');
      expect([...sharedSession.governancePlans.values()].filter(plan =>
        plan.planId === PLAN.plan_id).map(plan => plan.ownerAgentUrl).sort()).toEqual([ATTACKER, OWNER].sort());
    });
  });
});
