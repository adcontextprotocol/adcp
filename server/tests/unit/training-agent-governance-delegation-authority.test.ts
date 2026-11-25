/**
 * `delegations[].authority: "execute_only"` (adcp#9075, specification.mdx
 * "Delegation"; enums/delegation-authority.json). An execute_only delegate acts
 * only on a pre-approved action, one whose action binding already holds an
 * approved intent check, which includes accept_proposal for it. An intent
 * check from such a delegate that would open a new action or increase
 * committed spend is denied with a finding, in every governance mode.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/training-agent/task-handlers.js';
import { handleCheckGovernance, handleSyncPlans } from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const OWNER = 'https://owner.example';
const DELEGATE = 'https://agency.example';
const SELLER = 'https://seller.example';
const OWNER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: OWNER };
const DELEGATE_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: DELEGATE };
const SELLER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: SELLER };
const PLAN = {
  plan_id: 'plan-execute-only',
  brand: { domain: 'execute-only.example' },
  objectives: 'An agency executes what the brand already approved.',
  budget: { total: 100_000, currency: 'USD', reallocation_threshold: 100_000 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
  countries: ['US'],
};

type Result = Record<string, any>;

async function sync(authority = 'execute_only', mode = 'enforce') {
  const result = await handleSyncPlans({
    plans: [{
      ...PLAN,
      mode,
      delegations: [{ agent_url: DELEGATE, authority, budget_limit: { amount: 25_000, currency: 'USD' } }],
    }],
  }, OWNER_CTX) as Result;
  expect(result.errors).toBeUndefined();
}

function createIntent(caller: string, ctx: TrainingContext, amount: number): Promise<Result> {
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller,
    target_agent: SELLER,
    tool: 'create_media_buy',
    payload: { total_budget: { amount, currency: 'USD' }, geo: { countries: ['US'] } },
  }, ctx) as Promise<Result>;
}

/** The brand opens and the seller commits a buy: a pre-approved action. */
async function ownerBuy(mediaBuyId: string) {
  const intent = await createIntent(OWNER, OWNER_CTX, 10_000);
  expect(intent.verdict, JSON.stringify(intent)).toBe('approved');
  const purchase = await handleCheckGovernance({
    caller: SELLER,
    governance_context: intent.governance_context,
    phase: 'purchase',
    planned_delivery: { media_buy_id: mediaBuyId, total_budget: 10_000, currency: 'USD' },
  }, SELLER_CTX) as Result;
  expect(purchase.verdict, JSON.stringify(purchase)).toBe('approved');
}

function updateIntent(mediaBuyId: string, amount: number): Promise<Result> {
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller: DELEGATE,
    target_agent: SELLER,
    tool: 'update_media_buy',
    payload: { media_buy_id: mediaBuyId, end_time: '2027-06-30T23:59:59Z' },
    proposed_commitment: { amount, currency: 'USD' },
  }, DELEGATE_CTX) as Promise<Result>;
}

function proposal(
  proposalId: string,
  kind: 'new_media_buy' | 'media_buy_update',
  extra: Record<string, unknown> = {},
): Record<string, any> {
  const commercialTerms = {
    purchases: [{
      product_id: 'display_q2',
      budget: 20_000,
      start_time: '2027-04-01T00:00:00Z',
      end_time: '2027-06-30T23:59:59Z',
      targeting_overlay: { geo_countries: ['US'] },
    }],
    start_time: '2027-04-01T00:00:00Z',
    end_time: '2027-06-30T23:59:59Z',
    total_budget: { amount: 20_000, currency: 'USD' },
  };
  return {
    proposal_id: proposalId,
    proposal_kind: kind,
    proposal_status: 'committed',
    commercial_terms: commercialTerms,
    terms_digest: `sha256:${createHash('sha256').update(canonicalize(commercialTerms), 'utf8').digest('base64url')}`,
    ...extra,
  };
}

function acceptIntent(
  caller: string,
  ctx: TrainingContext,
  accepted: Record<string, any>,
  amount: number,
): Promise<Result> {
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller,
    target_agent: SELLER,
    tool: 'accept_proposal',
    payload: { proposal_id: accepted.proposal_id, proposal_terms_digest: accepted.terms_digest },
    proposal: accepted,
    proposed_commitment: { amount, currency: 'USD' },
  }, ctx) as Promise<Result>;
}

function expectExecuteOnlyDenial(result: Result, explanation: string) {
  expect(result.errors, JSON.stringify(result)).toBeUndefined();
  expect(result.verdict).toBe('denied');
  expect(result.governance_context).toBeUndefined();
  expect(result.findings).toContainEqual(expect.objectContaining({
    category_id: 'delegation_authority',
    severity: 'critical',
    explanation: expect.stringContaining(explanation),
  }));
}

describe('check_governance execute_only delegation authority', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it.each(['enforce', 'advisory', 'audit'])('denies a new action from an execute_only delegate in %s mode', async mode => {
    await runWithSessionContext(async () => {
      await sync('execute_only', mode);
      expectExecuteOnlyDenial(
        await createIntent(DELEGATE, DELEGATE_CTX, 20_000),
        'would open a new governed action',
      );
    });
  });

  it('lets a full delegate open the same action', async () => {
    await runWithSessionContext(async () => {
      await sync('full');
      const result = await createIntent(DELEGATE, DELEGATE_CTX, 20_000);
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
      expect(result.governance_context).toBeDefined();
    });
  });

  it('lets an execute_only delegate act on a pre-approved buy without new spend', async () => {
    await runWithSessionContext(async () => {
      await sync();
      await ownerBuy('mb_pre_approved');
      const result = await updateIntent('mb_pre_approved', 0);
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
      expect(result.governance_context).toBeDefined();
    });
  });

  it('denies an execute_only delegate that increases committed spend on a pre-approved buy', async () => {
    await runWithSessionContext(async () => {
      await sync();
      await ownerBuy('mb_pre_approved');
      expectExecuteOnlyDenial(await updateIntent('mb_pre_approved', 5_000), 'cannot increase committed spend');
    });
  });

  it('denies an execute_only delegate acting on a buy no approved intent governs', async () => {
    await runWithSessionContext(async () => {
      await sync();
      await ownerBuy('mb_pre_approved');
      expectExecuteOnlyDenial(await updateIntent('mb_never_approved', 0), 'would open a new governed action');
    });
  });

  it('lets an execute_only delegate accept a proposal whose acceptance the brand approved', async () => {
    await runWithSessionContext(async () => {
      await sync();
      const approvedProposal = proposal('proposal_pre_approved', 'new_media_buy');
      const ownerAccept = await acceptIntent(OWNER, OWNER_CTX, approvedProposal, 20_000);
      expect(ownerAccept.verdict, JSON.stringify(ownerAccept)).toBe('approved');

      const delegateAccept = await acceptIntent(DELEGATE, DELEGATE_CTX, approvedProposal, 20_000);
      expect(delegateAccept.verdict, JSON.stringify(delegateAccept)).toBe('approved');

      expectExecuteOnlyDenial(
        await acceptIntent(DELEGATE, DELEGATE_CTX, proposal('proposal_never_approved', 'new_media_buy'), 20_000),
        'would open a new governed action',
      );
    });
  });

  it('lets an execute_only delegate accept a no-cost update proposal for a pre-approved buy', async () => {
    await runWithSessionContext(async () => {
      await sync();
      await ownerBuy('mb_pre_approved');
      const update = proposal('proposal_update', 'media_buy_update', {
        media_buy_id: 'mb_pre_approved',
        parent_proposal_id: 'proposal_parent',
        base_media_buy_revision: 1,
      });

      const noCost = await acceptIntent(DELEGATE, DELEGATE_CTX, update, 0);
      expect(noCost.verdict, JSON.stringify(noCost)).toBe('approved');

      expectExecuteOnlyDenial(
        await acceptIntent(DELEGATE, DELEGATE_CTX, update, 5_000),
        'cannot increase committed spend',
      );
    });
  });
});
